import { expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { GatewayApprovalEventSubscriber } from "../infra/approval-gateway-runtime.types.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
// First dispatch lazily loads these modules; keep cold compilation outside the test deadline.
import "./agent-turn/agent-request-preflight.js";
import "./agent-turn/agent-turn-service.js";
import "./agent-turn/principal.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "./test-helpers.rpc-source.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

function createContext(): GatewayRequestContext {
  return {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn(), error: vi.fn() },
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRuntime({
  context = createContext(),
  handlers = {},
  ...options
}: Partial<Parameters<typeof createGatewayInstanceRuntime>[0]> & {
  context?: GatewayRequestContext;
  handlers?: GatewayRequestHandlers;
} = {}) {
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: name.includes("approval") ? APPROVALS_SCOPE : WRITE_SCOPE,
    })),
  );
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => true,
    ...options,
  });
  onTestFinished(() => runtime.close());
  return runtime;
}

function subscribe(
  runtime: ReturnType<typeof createRuntime>,
  onRequested: GatewayApprovalEventSubscriber["onRequested"],
  shouldHandle: GatewayApprovalEventSubscriber["shouldHandle"] = () => true,
) {
  return runtime.nativeApprovals.subscribe({
    eventKinds: new Set(["exec"]),
    shouldHandle,
    onRequested,
    onResolved: vi.fn(),
  });
}

function approvalRequest(id: string, request = {}) {
  return { id, request, createdAtMs: 1, expiresAtMs: 2 };
}

const unavailable = "Gateway instance dispatch unavailable";

it("retains only the exact failed placement until its generation or Gateway changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    const target = {
      sessionId: "failed-session",
      sessionKey: "agent:main:dashboard:failed-placement",
      agentId: "main",
    };
    const context = createContext();
    context.workerSessionPlacementService = placements;
    const runtime = createRuntime({ context });
    const request = { ...target, profileId: "synthetic", executionMode: "worker-turn" as const };
    const requested = await placements.startDispatch(request);
    const failure = await placements.fail({
      sessionId: target.sessionId,
      expectedGeneration: requested.generation,
      recoveryError: "Synthetic worker setup failure",
    });
    await expect(
      runtime.recovery.prepareFailedWorkerPlacement({ ...target, agentId: "other" }),
    ).resolves.toBeUndefined();
    const prepared = await runtime.recovery.prepareFailedWorkerPlacement(target);
    expect(prepared?.reason).toContain(failure.recoveryError);
    expect(prepared?.reason).toContain("restart the worker");
    expect(prepared?.isCurrent()).toBe(true);
    await placements.startDispatch(request);
    expect(prepared?.isCurrent()).toBe(false);
    prepared?.release();
    await expect(runtime.recovery.prepareFailedWorkerPlacement(target)).resolves.toBeUndefined();
    runtime.close();
    await expect(runtime.recovery.prepareFailedWorkerPlacement(target)).rejects.toThrow(
      unavailable,
    );
  });
});

async function expectCompleted(id: string) {
  expect(await findDeliveryIntentOwner(id)).toMatchObject({ status: "completed" });
}

it.each([false, true])(
  "revalidates recovery authority across admission (dedicated principal=%s)",
  async (dedicatedPrincipal) => {
    const context = createContext();
    const payload = { runId: "bound-recovery", status: "ok", summary: "completed" };
    context.dedupe.set("agent:bound-recovery", { ts: Date.now(), ok: true, payload });
    const { recovery } = createRuntime({ context });
    let requesterCurrent = true;
    const options = {
      expectFinal: true,
      ...(dedicatedPrincipal
        ? { runtimeContextFragments: [{ kind: "runtime-instruction" as const, text: "media" }] }
        : {}),
      assertAdmissionCurrent: () => {
        if (!requesterCurrent) {
          throw new Error("Recovery requester retired");
        }
      },
    };
    const request = { message: "completed media", idempotencyKey: "bound-recovery" };
    await expect(recovery.dispatchAgent(request, undefined, options)).resolves.toEqual(payload);
    const pending = recovery.dispatchAgent(request, undefined, options);
    requesterCurrent = false;
    await expect(pending).rejects.toThrow("Recovery requester retired");
  },
);

it("uses the typed recovery path and fails closed when the owning instance closes", async () => {
  let available = false;
  const rawAgent = vi.fn<NonNullable<GatewayRequestHandlers["agent"]>>(({ respond }) =>
    respond(true, { raw: true }),
  );
  const context = createContext();
  const preparing = createDeferred<number | undefined>();
  const runtime = createRuntime({
    context,
    handlers: { agent: rawAgent },
    isDispatchAvailable: () => available,
    prepareRestartRecovery: () => preparing.promise,
  });
  const { recovery } = runtime;
  expect(getGatewayRecoveryRuntime()).toBe(recovery);

  await expect(
    recovery.dispatchAgent({ message: "test", idempotencyKey: "run-unavailable" }),
  ).rejects.toMatchObject({
    name: "GatewayDispatchUnavailableError",
    message: expect.stringContaining(unavailable),
    retryable: true,
  });
  available = true;
  await expect(recovery.waitForAgent({ runId: "run-1", timeoutMs: 0 })).resolves.toEqual({
    runId: "run-1",
    status: "timeout",
  });
  const onExecutionStarted = vi.fn();
  context.dedupe.set("agent:active", {
    ts: Date.now(),
    ok: true,
    payload: { runId: "active", status: "accepted" },
  });
  const activeSource = createRpcSourceForTest({}, { runId: "active" });
  await claimRpcSourceForTest(activeSource);
  rpcSourceTesting.set("active", activeSource);
  await expect(
    recovery.dispatchAgent({ message: "test", idempotencyKey: "active" }, undefined, {
      onExecutionStarted,
    }),
  ).resolves.toMatchObject({ runId: "active", status: "in_flight" });
  expect(onExecutionStarted).toHaveBeenCalledOnce();
  await expect(
    recovery.dispatchAgent({ message: "test", idempotencyKey: "typed", cwd: "relative" }),
  ).rejects.toThrow("cwd must be absolute");
  expect(rawAgent).not.toHaveBeenCalled();

  const retainedFacade = await runtime.createAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] }),
  });
  const preparation = recovery.prepareRestartRecovery();
  runtime.close();
  preparing.resolve(undefined);
  await expect(preparation).rejects.toThrow(unavailable);
  expect(getGatewayRecoveryRuntime()).toBeUndefined();
  await expect(recovery.waitForAgent({ runId: "run-1" })).rejects.toMatchObject({
    name: "GatewayDispatchUnavailableError",
    message: expect.stringContaining(unavailable),
    retryable: false,
  });
  await expect(
    retainedFacade.dispatch({ message: "stale completion", idempotencyKey: "closed-host" }),
  ).rejects.toThrow(unavailable);
  await expect(retainedFacade.wait({ runId: "run-1" })).rejects.toThrow(unavailable);
});

it("sends recovery notices through normal outbound without invoking plugin actions", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "recovery-notice-" }, async () => {
    let platformDispatchHold: Promise<void> | undefined;
    const visibleSend = vi.fn();
    const sendText = vi.fn(async (ctx: { onPlatformSendDispatch?: () => Promise<void> }) => {
      await platformDispatchHold;
      await ctx.onPlatformSendDispatch?.();
      visibleSend();
      return { channel: "signal", messageId: `signal-message-${visibleSend.mock.calls.length}` };
    });
    const handleAction = vi.fn(async () => {
      throw new Error("recovery notice must not invoke message actions");
    });
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        label: "Signal",
        config: { listAccountIds: () => ["work"], isConfigured: () => true },
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: () => false,
        handleAction,
      },
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to }) => ({ ok: true, to: to?.trim() ?? "" }),
        sendText,
      },
    };
    const pluginRegistrySnapshot = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin }]),
      null,
      "default",
    );
    const context = {
      ...createContext(),
      getRuntimeConfig: () => ({ channels: { signal: { enabled: true } } }),
    } as GatewayRequestContext;
    const runtime = createRuntime({ context });

    try {
      const idempotencyKey = "main-session-restart-recovery:run-1:failed-notice";
      const target = {
        to: "+15551234567",
        accountId: "work",
        threadId: "thread-1",
        text: "Recovery notice",
      };
      const generation = {
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        sessionKey: "agent:main:dashboard:notice",
        sessionId: "notice-session",
        lifecycleRevision: null,
      };
      await replaceSessionEntry(generation, { sessionId: generation.sessionId, updatedAt: 1 });
      const notice = {
        channel: "signal",
        ...target,
        idempotencyKey,
        generation,
        provenance: { kind: "recovery-notice" as const, noticeId: idempotencyKey },
      };
      await runtime.recovery.sendRecoveryNotice(notice);
      await runtime.recovery.sendRecoveryNotice(notice);

      await expectCompleted(idempotencyKey);
      expect(visibleSend).toHaveBeenCalledOnce();

      let ownerCurrent = true;
      const platformDispatch = createDeferred();
      platformDispatchHold = platformDispatch.promise;
      const staleDelivery = runtime.recovery.sendRecoveryNotice({
        ...notice,
        idempotencyKey: "main-session-restart-recovery:run-2:failed-notice",
        provenance: {
          kind: "recovery-notice",
          noticeId: "main-session-restart-recovery:run-2:failed-notice",
        },
        isCurrent: () => ownerCurrent,
      });
      await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
      const queuedResumption = await findDeliveryIntentOwner(
        "main-session-restart-recovery:run-2:failed-notice",
      );
      ownerCurrent = false;
      platformDispatch.resolve();

      await expect(staleDelivery).rejects.toThrow("Recovery notice owner retired before delivery");

      expect(visibleSend).toHaveBeenCalledOnce();
      expect(queuedResumption).toMatchObject({ namespace: "prepared", status: "pending" });
      expect(sendText).toHaveBeenCalledWith(expect.objectContaining(target));
      expect(handleAction).not.toHaveBeenCalled();

      const guardedDurableNotice = {
        ...notice,
        idempotencyKey: "main-session-restart-recovery:subagent:run-3:resumed-notice",
        provenance: {
          kind: "recovery-notice" as const,
          noticeId: "main-session-restart-recovery:subagent:run-3:resumed-notice",
        },
        isCurrent: () => true,
      };
      await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
      await expectCompleted(guardedDurableNotice.idempotencyKey);
      await runtime.recovery.sendRecoveryNotice(guardedDurableNotice);
      expect(visibleSend).toHaveBeenCalledTimes(2);
      await expectCompleted(guardedDurableNotice.idempotencyKey);
      runtime.close();
      await expect(runtime.recovery.sendRecoveryNotice(notice)).rejects.toThrow(
        "Gateway instance dispatch unavailable for recovery notice",
      );
    } finally {
      runtime.close();
      restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
    }
  });
});

it("keeps approval subscribers isolated by Gateway instance and unregisters exactly once", async () => {
  const first = createRuntime();
  const second = createRuntime();
  expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
  const onRequested = vi.fn();
  const unsubscribe = subscribe(first, onRequested);
  const request = approvalRequest("approval-1");

  expect(second.approvalEvents.publishRequested("exec", request)).toBe(0);
  expect(first.approvalEvents.publishRequested("plugin", request)).toBe(0);
  expect(first.approvalEvents.publishRequested("exec", request)).toBe(1);
  expect(onRequested).toHaveBeenCalledOnce();

  unsubscribe();
  unsubscribe();
  expect(first.approvalEvents.publishRequested("exec", request)).toBe(0);

  const declined = vi.fn();
  subscribe(first, declined, async () => false);
  expect(await first.approvalEvents.publishRequestedAsync("exec", request)).toBe(0);
  expect(declined).not.toHaveBeenCalled();
  first.close();
  expect(getGatewayRecoveryRuntime()).toBe(second.recovery);
  second.close();
  expect(getGatewayRecoveryRuntime()).toBeUndefined();
});

it("refuses synchronous publication before sending when a subscriber requires async eligibility", async () => {
  const logError = vi.fn();
  const runtime = createRuntime({ logError });
  const pending = createDeferred<boolean>();
  const onRequested = vi.fn();
  subscribe(runtime, onRequested);
  subscribe(runtime, onRequested, () => pending.promise);
  expect(() =>
    runtime.approvalEvents.publishRequested("exec", approvalRequest("legacy-async-eligibility")),
  ).toThrow("use approvalEvents.publishRequestedAsync");
  expect(onRequested).not.toHaveBeenCalled();
  pending.reject(new Error("eligibility rejected"));
  await Promise.resolve();
  expect(logError).toHaveBeenCalledWith(expect.stringContaining("eligibility rejected"));
  expect(onRequested).not.toHaveBeenCalled();
});

it.each(["unsubscribe", "resolve", "close"] as const)(
  "retires native approval delivery when %s wins an async eligibility wait",
  async (retire) => {
    const eligibility = createDeferred<boolean>();
    const runtime = createRuntime();
    const onRequested = vi.fn();
    const unsubscribe = subscribe(runtime, onRequested, () => eligibility.promise);
    const publication = runtime.approvalEvents.publishRequestedAsync(
      "exec",
      approvalRequest("pending-eligibility", { command: "echo test" }),
    );
    if (retire === "unsubscribe") {
      unsubscribe();
    } else if (retire === "resolve") {
      runtime.approvalEvents.publishResolved("exec", { id: "pending-eligibility" });
    } else {
      runtime.close();
    }
    eligibility.resolve(true);
    expect(await publication).toBe(0);
    expect(onRequested).not.toHaveBeenCalled();
  },
);

it("reads current approval config only while its Gateway instance is open", () => {
  const initial = { gateway: { publicOrigin: "https://before.example.com" } };
  const next = { gateway: { publicOrigin: "https://after.example.com" } };
  let current = initial;
  const context = { ...createContext(), getRuntimeConfig: () => current };
  const runtime = createRuntime({ context });
  const getRuntimeConfig = runtime.nativeApprovals.getRuntimeConfig;
  expect(getRuntimeConfig()).toBe(initial);
  current = next;
  expect(getRuntimeConfig()).toBe(next);
  runtime.close();
  expect(() => getRuntimeConfig()).toThrow("Gateway instance approval runtime is closed");
});

it("rejects methods outside each closed internal principal", async () => {
  const runtime = createRuntime();

  await expect(
    runtime.nativeApprovals.request("config.get" as GatewayNativeApprovalMethod, {}),
  ).rejects.toThrow("internal principal cannot dispatch config.get");
  await expect(runtime.nativeApprovals.requestRoute("config.get" as "send", {})).rejects.toThrow(
    "internal principal cannot dispatch config.get",
  );
});

it("preserves a trusted approval resolver display name", async () => {
  const displayName = "Telegram approval (owner)";
  const { nativeApprovals } = createRuntime({
    handlers: {
      "exec.approval.list": ({ client, respond }) =>
        respond(true, { displayName: client?.connect.client.displayName }),
    },
  });

  await expect(
    nativeApprovals.request("exec.approval.list", {}, { clientDisplayName: displayName }),
  ).resolves.toEqual({ displayName });
});

it("preserves the Gateway client's approval request deadline", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { promise: started, resolve: markStarted } = createDeferred();
  const { promise: handlerCanFinish, resolve: finishHandler } = createDeferred();
  const runtime = createRuntime({
    handlers: {
      send: async () => {
        markStarted();
        await handlerCanFinish;
      },
    },
  });

  try {
    const request = runtime.nativeApprovals.requestRoute("send", { message: "test" });
    const error = request.catch((value: unknown) => value);
    await started;
    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    const caught = await error;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("gateway request timeout for send");
  } finally {
    finishHandler();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    runtime.close();
  }
});
