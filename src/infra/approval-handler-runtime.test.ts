import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "./approval-handler-adapter-runtime.js";
import type { ChannelApprovalNativeRuntimeAdapter } from "./approval-handler-runtime-types.js";
import {
  createChannelApprovalNativeRuntimeAdapter,
  createChannelApprovalHandlerFromCapability as createHandler,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";
import {
  createApprovalNativeRuntimeAdapterStubs,
  type ApprovalNativeRuntimeAdapterStubParams,
} from "./approval-handler.test-helpers.js";
import type { NormalizedApprovalRequest } from "./approval-types.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalCapability = NonNullable<Parameters<typeof createHandler>[0]["capability"]>;
type ApprovalNativeAdapter = NonNullable<ApprovalCapability["native"]>;

const TEST_HANDLER_PARAMS = {
  label: "test/approval-handler",
  clientDisplayName: "Test Approval Handler",
  channel: "test",
  channelLabel: "Test",
  cfg: { channels: {} } as never,
} as const;

function makeExecApprovalRequest(id: string): NormalizedApprovalRequest<ExecApprovalRequest> {
  return {
    approvalKind: "exec",
    id,
    expiresAtMs: Date.now() + 60_000,
    request: {
      command: "echo hi",
      turnSourceChannel: "test",
      turnSourceTo: "origin-chat",
    },
    createdAtMs: Date.now(),
  };
}

function makePluginRequest(
  id: string,
  request: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    id,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    request: { title: "Plugin approval", description: "Allow the plugin action", ...request },
  };
}

function makeNativeApprovalCapability(
  params: {
    preferredSurface?: ReturnType<
      ApprovalNativeAdapter["describeDeliveryCapabilities"]
    >["preferredSurface"];
    supportsApproverDmSurface?: boolean;
    resolveApproverDmTargets?: ApprovalNativeAdapter["resolveApproverDmTargets"];
  } & ApprovalNativeRuntimeAdapterStubParams = {},
) {
  const preferredSurface = params.preferredSurface ?? "origin";
  return {
    native: {
      describeDeliveryCapabilities: vi.fn().mockReturnValue({
        enabled: true,
        preferredSurface,
        supportsOriginSurface: true,
        supportsApproverDmSurface: params.supportsApproverDmSurface ?? false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: vi.fn().mockReturnValue({ to: "origin-chat" }),
      ...(params.resolveApproverDmTargets
        ? { resolveApproverDmTargets: params.resolveApproverDmTargets }
        : {}),
    },
    nativeRuntime: createApprovalNativeRuntimeAdapterStubs(params),
  } satisfies ApprovalCapability;
}

async function createTestApprovalHandler(
  params: Parameters<typeof makeNativeApprovalCapability>[0],
) {
  return requireHandler({
    capability: makeNativeApprovalCapability(params),
    ...TEST_HANDLER_PARAMS,
  });
}

async function requireHandler(params: Parameters<typeof createHandler>[0]) {
  const runtime = await createHandler(params);
  if (runtime === null) {
    throw new Error("Expected approval handler runtime");
  }
  return runtime;
}

function makeLazyFixture(
  onDelivered?: NonNullable<
    ChannelApprovalNativeRuntimeAdapter<{ text: string }>["observe"]
  >["onDelivered"],
) {
  return {
    availability: { isConfigured: vi.fn(), shouldHandle: vi.fn() },
    presentation: {
      buildPendingPayload: vi.fn(async () => ({ text: "pending" })),
      buildResolvedResult: vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: { prepareTarget: vi.fn(), deliverPending: vi.fn() },
    ...(onDelivered ? { observe: { onDelivered } } : {}),
  } satisfies ChannelApprovalNativeRuntimeAdapter<{ text: string }>;
}

function gatedResult<T>(result: T) {
  const entered = createDeferred();
  const gate = createDeferred();
  const callback = vi.fn(async () => {
    entered.resolve();
    await gate.promise;
    return result;
  });
  return { entered, gate, callback };
}

function firstCallArg(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls[0]?.[0] as
    | { entry?: unknown; binding?: unknown; request?: unknown; approvalKind?: string }
    | undefined;
}

describe("createChannelApprovalHandlerFromCapability", () => {
  it("awaits async native eligibility before loading delivery hooks", async () => {
    const deliverPending = vi.fn().mockResolvedValue({ messageId: "async-card" });
    const capability = makeNativeApprovalCapability({ deliverPending });
    const nativeRuntime = capability.nativeRuntime;
    if (!nativeRuntime) {
      throw new Error("Expected fixture native runtime");
    }
    const load = vi.fn(async () => nativeRuntime);
    const eligibility = createDeferred<boolean>();
    const nativeRuntimeAsync = createLazyChannelApprovalNativeRuntimeAdapterAsync({
      load,
      isConfigured: async () => true,
      shouldHandle: () => eligibility.promise,
    });
    const runtime = await requireHandler({
      capability: { native: capability.native, nativeRuntimeAsync },
      ...TEST_HANDLER_PARAMS,
    });
    const requested = runtime.handleRequested(makeExecApprovalRequest("async-declined"));
    eligibility.resolve(false);
    await requested;
    expect(load).not.toHaveBeenCalled();
    expect(deliverPending).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("returns null when the capability does not expose a native runtime", async () => {
    await expect(
      createHandler({
        capability: {},
        ...TEST_HANDLER_PARAMS,
      }),
    ).resolves.toBeNull();
  });

  it("keeps an older channel runtime from sending cards under scoped plugin reviewer policy", async () => {
    const deliverPending = vi.fn().mockResolvedValue({ messageId: "1" });
    const runtime = await createHandler({
      capability: makeNativeApprovalCapability({ eventKinds: ["plugin"], deliverPending }),
      ...TEST_HANDLER_PARAMS,
      channel: "slack",
      cfg: {
        approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
      },
    });
    await runtime?.handleRequested(
      makePluginRequest("plugin:older-channel", { turnSourceChannel: "slack" }),
    );
    expect(deliverPending).not.toHaveBeenCalled();
    await runtime?.stop();
  });

  it.each([false, true])(
    "retains the normalized request and selected kind through stop (override=%s)",
    async (override) => {
      const unbindPending = vi.fn();
      const shouldHandle = vi.fn().mockReturnValue(true);
      const approvalKind = override ? "exec" : "plugin";
      const resolveApprovalKind = vi.fn().mockReturnValue(approvalKind);
      const capability = makeNativeApprovalCapability({
        eventKinds: [approvalKind],
        shouldHandle,
        unbindPending,
        ...(override ? { resolveApprovalKind } : {}),
      });
      const buildPendingPayload = vi.fn().mockResolvedValue({ text: "pending" });
      capability.nativeRuntime.presentation.buildPendingPayload = buildPendingPayload;
      const approvalRuntime = await requireHandler({ ...TEST_HANDLER_PARAMS, capability });
      const request = override
        ? makePluginRequest("plugin:legacy-owned-id")
        : makePluginRequest("custom:1", { turnSourceChannel: "test", turnSourceTo: "origin-chat" });
      const normalizedRequest = { ...request, approvalKind: "plugin" as const };
      await approvalRuntime.handleRequested(request);
      if (override) {
        expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
      }
      expect(shouldHandle).toHaveBeenCalledWith(
        expect.objectContaining({ request: normalizedRequest, approvalKind }),
      );
      expect(buildPendingPayload).toHaveBeenCalledWith(
        expect.objectContaining({ request: normalizedRequest, approvalKind }),
      );
      await approvalRuntime.stop();

      expect(unbindPending).toHaveBeenCalledOnce();
      expect(firstCallArg(unbindPending)).toHaveProperty("request", normalizedRequest);
      expect(firstCallArg(unbindPending)).toHaveProperty("approvalKind", approvalKind);
    },
  );

  it.each(["resolved", "expired"] as const)(
    "normalizes and cleans up %s system-agent entries through a lazy native runtime",
    async (phase) => {
      const shouldHandle = vi.fn().mockReturnValue(true);
      const unbindPending = vi.fn();
      const onFinalized = vi.fn();
      const buildResult = vi.fn().mockResolvedValue({ kind: "leave" });
      const otherResult = vi.fn().mockResolvedValue({ kind: "leave" });
      const nativeRuntime = createApprovalNativeRuntimeAdapterStubs({
        eventKinds: ["system-agent"],
        shouldHandle,
        buildResolvedResult: phase === "resolved" ? buildResult : otherResult,
        unbindPending,
        onFinalized,
      });
      nativeRuntime.presentation.buildExpiredResult =
        phase === "expired" ? buildResult : otherResult;
      const approvalRuntime = await requireHandler({
        ...TEST_HANDLER_PARAMS,
        capability: {
          ...makeNativeApprovalCapability(),
          nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
            eventKinds: nativeRuntime.eventKinds,
            ...nativeRuntime.availability,
            load: async () => nativeRuntime,
          }),
        },
      });
      const request = {
        id: "system-agent:1",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"] as const,
          sessionId: "delegation-1",
        },
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
      };

      await approvalRuntime.handleRequested(request);
      expect(shouldHandle).toHaveBeenCalledWith(
        expect.objectContaining({ approvalKind: "system-agent" }),
      );
      if (phase === "resolved") {
        await approvalRuntime.handleResolved({ id: request.id, decision: "deny", ts: 1 } as never);
      } else {
        await approvalRuntime.handleExpired(request.id);
      }

      expect(unbindPending).toHaveBeenCalledWith(
        expect.objectContaining({ approvalKind: "system-agent" }),
      );
      expect(buildResult).toHaveBeenCalledOnce();
      expect(otherResult).not.toHaveBeenCalled();
      expect(onFinalized).toHaveBeenCalledWith(
        expect.objectContaining({ approvalKind: "system-agent", phase }),
      );
    },
  );

  it.each(["resolved", "stop"] as const)(
    "continues %s cleanup after an unbind failure",
    async (phase) => {
      const unbindPending = vi
        .fn()
        .mockRejectedValueOnce(new Error("unbind failed"))
        .mockResolvedValueOnce(undefined);
      const buildResolvedResult = vi.fn().mockResolvedValue({ kind: "leave" });
      const approvalRuntime = await createTestApprovalHandler({
        ...(phase === "resolved"
          ? {
              preferredSurface: "both" as const,
              supportsApproverDmSurface: true,
              resolveApproverDmTargets: vi.fn().mockResolvedValue([{ to: "approver-dm" }]),
              buildResolvedResult,
              prepareTarget: vi.fn().mockImplementation(async ({ plannedTarget }) => ({
                dedupeKey: String(plannedTarget.target.to),
                target: { to: plannedTarget.target.to },
              })),
            }
          : {}),
        deliverPending: vi
          .fn()
          .mockResolvedValueOnce({ messageId: "1" })
          .mockResolvedValueOnce({ messageId: "2" }),
        bindPending: vi
          .fn()
          .mockResolvedValueOnce({ bindingId: "bound-1" })
          .mockResolvedValueOnce({ bindingId: "bound-2" }),
        unbindPending,
      });

      const request = makeExecApprovalRequest(phase === "resolved" ? "exec:2" : "exec:stop-1");
      await approvalRuntime.handleRequested(request);
      if (phase === "resolved") {
        await expect(
          approvalRuntime.handleResolved({
            id: "exec:2",
            decision: "approved",
            resolvedBy: "operator",
          } as never),
        ).resolves.toBeUndefined();
        expect(buildResolvedResult).toHaveBeenCalledTimes(1);
        expect(firstCallArg(buildResolvedResult)?.entry).toEqual({ messageId: "2" });
      } else {
        await approvalRuntime.handleRequested({ ...request, id: "exec:stop-2" });
        await expect(approvalRuntime.stop()).resolves.toBeUndefined();
        expect(unbindPending).toHaveBeenCalledTimes(2);
        await expect(approvalRuntime.stop()).resolves.toBeUndefined();
      }
      expect(unbindPending).toHaveBeenCalledTimes(2);
    },
  );
});

describe("createLazyChannelApprovalNativeRuntimeAdapter", () => {
  it("loads the runtime lazily and reuses the loaded adapter", async () => {
    const explicitIsConfigured = vi.fn().mockReturnValue(true);
    const explicitShouldHandle = vi.fn().mockReturnValue(false);
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const pending = makeLazyFixture();
    const typedResolveApprovalKind = vi.fn().mockReturnValue("plugin");
    const fixture = createChannelApprovalNativeRuntimeAdapter({
      ...pending,
      resolveApprovalKind: typedResolveApprovalKind,
    });
    const { buildPendingPayload } = pending.presentation;
    const load = vi.fn(async () => fixture);
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec"],
      resolveApprovalKind,
      isConfigured: explicitIsConfigured,
      shouldHandle: explicitShouldHandle,
      load,
    });
    const cfg = { channels: {} } as never;
    const request = { id: "exec:1" } as never;
    const view = {} as never;
    const opaqueRequest = { id: "opaque-plugin-id" } as never;
    expect(fixture.resolveApprovalKind?.(opaqueRequest)).toBe("plugin");
    expect(typedResolveApprovalKind).toHaveBeenCalledWith(opaqueRequest);

    expectTypeOf<
      Awaited<ReturnType<typeof adapter.presentation.buildPendingPayload>>
    >().toEqualTypeOf<{ text: string }>();
    expect(adapter.eventKinds).toEqual(["exec"]);
    expect(adapter.resolveApprovalKind?.(request)).toBe("exec");
    expect(resolveApprovalKind).toHaveBeenCalledWith(request);
    expect(adapter.availability.isConfigured({ cfg })).toBe(true);
    expect(adapter.availability.shouldHandle({ cfg, request, approvalKind: "exec" })).toBe(false);
    const payload = { cfg, request, approvalKind: "exec" as const, nowMs: 1, view };
    await expect(adapter.presentation.buildPendingPayload(payload)).resolves.toEqual({
      text: "pending",
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(explicitIsConfigured).toHaveBeenCalledWith({ cfg });
    expect(explicitShouldHandle).toHaveBeenCalledWith({ cfg, request, approvalKind: "exec" });
    expect(buildPendingPayload).toHaveBeenCalledWith(payload);
  });

  it("keeps observe hooks synchronous and only uses the already-loaded runtime", async () => {
    const onDelivered = vi.fn();
    const load = vi.fn().mockResolvedValue(makeLazyFixture(onDelivered));
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      isConfigured: vi.fn().mockReturnValue(true),
      shouldHandle: vi.fn().mockReturnValue(true),
      load,
    });

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(load).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();

    await adapter.presentation.buildPendingPayload({
      cfg: {} as never,
      request: { id: "exec:1" } as never,
      approvalKind: "exec",
      nowMs: 1,
      view: {} as never,
    });
    expect(load).toHaveBeenCalledTimes(1);

    adapter.observe?.onDelivered?.({ request: { id: "exec:1" } } as never);
    expect(onDelivered).toHaveBeenCalledWith({ request: { id: "exec:1" } });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: "in-flight", phase: "bind", label: "in-flight approval binding" },
    { id: "pre-bind", phase: "deliver", label: "pre-bind approval delivery" },
    { id: "post-bind-null", phase: "bind", label: "null approval binding" },
  ])("cleans up $id when stop interrupts $phase", async ({ id, phase, label }) => {
    const entry = { messageId: id };
    const bound = id === "in-flight";
    const pending = gatedResult(
      phase === "deliver" ? entry : bound ? { bindingId: "bound-in-flight" } : null,
    );
    const bindPending =
      phase === "bind"
        ? pending.callback
        : vi.fn().mockResolvedValue({ bindingId: "should-not-bind" });
    const unbindPending = vi.fn();
    const cancelDelivered = vi.fn();
    const runtime = await createTestApprovalHandler({
      deliverPending: phase === "deliver" ? pending.callback : vi.fn().mockResolvedValue(entry),
      bindPending,
      unbindPending,
      ...(bound ? {} : { cancelDelivered }),
    });
    const request = makeExecApprovalRequest(`exec:${id}`);
    const inflight = runtime.handleRequested(request);
    await withTestTimeout(pending.entered.promise, 1_000, `${label} did not start`);
    await runtime.stop();
    pending.gate.resolve();
    await inflight;
    if (bound) {
      expect(unbindPending).toHaveBeenCalledTimes(1);
      const unbind = firstCallArg(unbindPending);
      expect(unbind?.entry).toEqual({ messageId: "in-flight" });
      expect(unbind?.binding).toEqual({ bindingId: "bound-in-flight" });
      expect(unbind?.request).toBe(request);
    } else {
      expect(unbindPending).not.toHaveBeenCalled();
      expect(cancelDelivered).toHaveBeenCalledTimes(1);
      const cancel = firstCallArg(cancelDelivered);
      expect(cancel?.entry).toBe(entry);
      expect(cancel?.request).toBe(request);
      if (phase === "deliver") {
        expect(bindPending).not.toHaveBeenCalled();
        expect(cancel?.approvalKind).toBe("exec");
      }
    }
  });
});
