import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalHistoryResult,
  validateApprovalGetResult,
  validateApprovalHistoryResult,
  validateApprovalResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { installTestApprovalClock } from "../exec-approval-manager.test-support.js";
import { insertOperatorApproval } from "../operator-approval-store.js";
import * as operatorApprovalStore from "../operator-approval-store.js";
import {
  cancelAgentRuntimeBoundApprovals,
  cancelUnboundRunApprovals,
} from "./approval-run-cancellation.js";
import {
  bindApprovalHandlers as bindHandlers,
  createHandlers,
  createFixture as createHandlerFixture,
  cleanupApprovalHandlerFixtures,
  createClient,
  createManagers,
  getOperatorApproval,
  registerExec,
  registerPlugin,
  tempDirs,
} from "./approval.handlers.test-support.js";
import {
  corruptDurableApprovalPresentation,
  createContext,
  deleteDurableApproval,
} from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// mock-isolation: Handler fixtures control custody without loading live channel plugins or sessions.
vi.mock("../approval-channel-custody.js", () => ({ prepareApprovalChannelCustody: vi.fn() }));

function createForwarder(overrides: Partial<ExecApprovalForwarder>): ExecApprovalForwarder {
  return {
    handleRequested: vi.fn(async () => false),
    handleResolved: vi.fn(async () => {}),
    handlePluginApprovalRequested: vi.fn(async () => false),
    handlePluginApprovalResolved: vi.fn(async () => {}),
    stop: vi.fn(),
    ...overrides,
  };
}

function bindApprovalHandlers(handlers: Parameters<typeof bindHandlers>[0]) {
  const request = bindHandlers(handlers);
  return Object.assign(request, {
    resolve(
      id: string | undefined,
      options: {
        kind?: "exec" | "plugin";
        decision?: string;
        deviceId?: string;
        context?: GatewayRequestHandlerOptions["context"];
      } = {},
    ) {
      const { kind = "exec", decision = "deny", deviceId, context } = options;
      return request(
        "approval.resolve",
        { id, kind, decision },
        deviceId ? createClient({ deviceId }) : undefined,
        context,
      );
    },
  });
}

function createFixture() {
  const fixture = createHandlerFixture();
  return { ...fixture, request: bindApprovalHandlers(fixture.handlers) };
}

function useApprovalClock() {
  installTestApprovalClock();
  const get = operatorApprovalStore.getOperatorApprovalDetailed;
  vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation((params) =>
    get({ ...params, nowMs: Date.now() }),
  );
  return vi.spyOn(Date, "now").mockReturnValue(1_000);
}

function recipientOptions(context: GatewayRequestHandlerOptions["context"]) {
  return vi.mocked(expectDefined(context.getApprovalClientConnIds, "approval lookup")).mock
    .calls[0]?.[0];
}

function expectRecipients(
  context: GatewayRequestHandlerOptions["context"],
  field: "deviceId" | "connId",
  accepted: string,
  rejected: string,
) {
  const recipients = recipientOptions(context);
  for (const [id, included] of [
    [accepted, true],
    [rejected, false],
  ] as const) {
    const client = expectDefined(createClient({ [field]: id }), "approval recipient");
    expect(recipients?.filter?.(client, recipients.record)).toBe(included);
  }
}

function expectResolved(result: unknown, approval: Record<string, unknown>, applied = true) {
  expect(result).toMatchObject({ applied, approval });
}

function expectRetained(result: unknown, approval: Record<string, unknown>) {
  expectResolved(result, approval, false);
}

async function expectStorageFailure(
  response: Awaited<ReturnType<ReturnType<typeof bindHandlers>>>,
  manager: ExecApprovalManager,
  pending: Awaited<ReturnType<typeof registerExec>>,
) {
  expect(response).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
  });
  await expect(pending.decision).resolves.toBe("deny");
  expect(manager.getLiveSnapshot(pending.record.id)).toMatchObject({
    status: "denied",
    terminalReason: "storage-corrupt",
  });
}

describe("unified approval handlers", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });

  it("returns mapped terminal history with attribution and a next cursor", async () => {
    const { managers, request } = createFixture();
    const first = await registerExec(managers.exec, { id: "history:first" });
    const second = await registerPlugin(managers.plugin, { id: "history:second" });
    for (const [id, kind] of [
      [first.record.id, "exec"],
      [second.record.id, "plugin"],
    ] as const) {
      const response = await request("approval.resolve", { id, kind, decision: "deny" });
      expect(response.ok).toBe(true);
    }

    const firstPage = await request(
      "approval.history",
      { limit: 1 },
      undefined,
      createContext("/operator/"),
    );
    expect(firstPage.ok).toBe(true);
    expect(validateApprovalHistoryResult(firstPage.result)).toBe(true);
    const firstResult = firstPage.result as ApprovalHistoryResult;
    expect(firstResult.items).toHaveLength(1);
    expect(firstResult.items[0]).toMatchObject({
      status: "denied",
      decision: "deny",
      source: { agentId: "main", sessionKey: "agent:main:child" },
      resolver: { kind: "device", id: "reviewer" },
    });
    expect(firstResult.nextCursor).toEqual(expect.any(String));

    const secondPage = await request("approval.history", {
      cursor: firstResult.nextCursor,
      limit: 1,
    });
    expect(secondPage.ok).toBe(true);
    expect((secondPage.result as ApprovalHistoryResult).items).toHaveLength(1);
    expect((secondPage.result as ApprovalHistoryResult).nextCursor).toBeUndefined();
  });

  it("cancels only approvals owned by the aborted active run", async () => {
    const { managers, request } = createFixture();
    const aborted = await registerExec(managers.exec, {
      id: "aborted-run-approval",
      request: { runId: "run-active", toolCallId: "tool-active" },
      reviewerDeviceIds: ["later-surface"],
    });
    const completedRun = await registerExec(managers.exec, {
      id: "completed-run-approval",
      request: { runId: "run-completed", toolCallId: "tool-completed" },
    });
    const context = createContext();
    const publish = vi.fn();
    expect(
      await cancelUnboundRunApprovals({
        runId: "run-active",
        manager: managers.exec,
        publish,
      }),
    ).toBe(1);

    await expect(aborted.decision).resolves.toBeNull();
    expect(await managers.exec.getSnapshot(aborted.record.id)).toMatchObject({
      status: "cancelled",
      terminalReason: "run-aborted",
    });
    const completedRunSnapshot = await managers.exec.getSnapshot(completedRun.record.id);
    expect(completedRunSnapshot).toMatchObject({
      request: { runId: "run-completed" },
    });
    expect(completedRunSnapshot?.resolvedAtMs).toBeUndefined();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: aborted.record.id, decision: "deny" }),
      expect.objectContaining({ id: aborted.record.id }),
    );

    const replay = await request.resolve(aborted.record.id, {
      decision: "allow-once",
      deviceId: "later-surface",
      context,
    });
    expectRetained(replay.result, {
      id: aborted.record.id,
      status: "cancelled",
      reason: "run-aborted",
    });
  });

  it("cancels exact exec and plugin authority without touching a same-run successor", async () => {
    const { managers } = createFixture();
    const oldAuthority = {
      kind: "local" as const,
      operationalRunInstance: { instanceId: "instance-old", runId: "run-reused" },
      lifecycleGeneration: "generation-1",
      claimId: "claim-old",
    };
    const successorAuthority = {
      ...oldAuthority,
      operationalRunInstance: { instanceId: "instance-new", runId: "run-reused" },
      claimId: "claim-new",
    };
    const request = { runId: "run-reused" };
    const pairs = [
      [
        managers.exec,
        await registerExec(managers.exec, { id: "exec:old-authority", request }),
        await registerExec(managers.exec, { id: "exec:successor-authority", request }),
      ],
      [
        managers.plugin,
        await registerPlugin(managers.plugin, { id: "plugin:old-authority", request }),
        await registerPlugin(managers.plugin, { id: "plugin:successor-authority", request }),
      ],
    ] as const;
    for (const [, old, successor] of pairs) {
      old.record.agentRuntimeDelegatedAuthority = oldAuthority;
      successor.record.agentRuntimeDelegatedAuthority = successorAuthority;
    }
    for (const [manager, old] of pairs) {
      expect(
        await cancelAgentRuntimeBoundApprovals<typeof old.record.request>({
          authority: oldAuthority,
          reason: "permission-change",
          manager,
          publish: () => {},
        }),
      ).toBe(1);
    }
    for (const [manager, old, successor] of pairs) {
      await expect(old.decision).resolves.toBeNull();
      expect(old.record.resolvedBy).toBe("permission-change");
      expect((await manager.getSnapshot(successor.record.id))?.resolvedAtMs).toBeUndefined();
      await manager.resolve(successor.record.id, "deny");
      await successor.decision;
    }
  });

  it("resolves a durable deny without reconstructing a raw legacy request", async () => {
    const { databaseOptions, request } = createFixture();
    const id = "durable-deny-without-live-request";
    const nowMs = Date.now();
    await insertOperatorApproval({
      approval: {
        id,
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "durable safe preview",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "approval-handler-test",
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
      },
      databaseOptions,
    });
    const context = createContext();

    const response = await request.resolve(id, { context });
    expect(response.ok).toBe(true);
    expectResolved(response.result, {
      status: "denied",
      decision: "deny",
      presentation: { kind: "exec", commandText: "durable safe preview" },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("expires durable state on a forward-clock lookup and settles the live waiter", async () => {
    const now = useApprovalClock();
    const { managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "forward-clock-expiry",
      expiresAtMs: 2_000,
    });

    now.mockReturnValue(2_000);
    const response = await request("approval.get", { id: pending.record.id });
    expect(response.result).toMatchObject({
      approval: { status: "expired", reason: "timeout", resolvedAtMs: 2_000 },
    });
    expect(validateApprovalGetResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
  });

  it.each([
    ["missing", deleteDurableApproval, false],
    ["corrupt", corruptDurableApprovalPresentation, false],
    ["corrupt-through-transport-ref", corruptDurableApprovalPresentation, true],
  ] as const)(
    "fails the canonical live waiter closed for %s durable state",
    async (label, mutate, transportRef) => {
      const { databaseOptions, managers, request } = createFixture();
      const pending = await registerExec(managers.exec, { id: `durable-${label}` });
      const durable = transportRef
        ? expectDefined(
            await getOperatorApproval({ id: pending.record.id, databaseOptions }),
            "durable approval",
          )
        : undefined;
      mutate(databaseOptions, pending.record.id);
      const response = durable
        ? await request.resolve(durable.resolutionRef, {
            decision: "allow-once",
            deviceId: "telegram",
          })
        : await request("approval.get", { id: pending.record.id });
      await expectStorageFailure(response, managers.exec, pending);
    },
  );

  it("repairs durable pending state after a transient local storage failure", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-reconcile-"));
    tempDirs.push(stateDir);
    const databasePath = path.join(stateDir, "state.sqlite");
    const backupPath = path.join(stateDir, "state.backup.sqlite");
    const databaseOptions = { path: databasePath } satisfies OpenClawStateDatabaseOptions;
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, { id: "transient-storage-repair" });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    fs.renameSync(databasePath, backupPath);
    fs.mkdirSync(databasePath);
    await expect(
      managers.exec.resolveDetailed(
        pending.record.id,
        "deny",
        { kind: "device", id: "reviewer-device" },
        "Reviewer",
      ),
    ).rejects.toThrow();
    await expect(pending.decision).resolves.toBe("deny");
    fs.rmSync(databasePath, { recursive: true });
    fs.renameSync(backupPath, databasePath);
    const request = bindApprovalHandlers(createHandlers(managers, databaseOptions));
    const response = await request("approval.get", { id: pending.record.id });

    expect(response.result).toMatchObject({
      approval: {
        status: "denied",
        decision: "deny",
        reason: "storage-corrupt",
      },
    });
    expect(await getOperatorApproval({ id: pending.record.id, databaseOptions })).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("resolves plugin approvals through the durable CAS and publishes once", async () => {
    const { databaseOptions, managers } = createFixture();
    const pending = await registerPlugin(managers.plugin, {
      id: "plugin:deny-is-always-valid",
      request: { allowedDecisions: ["allow-once"] },
      reviewerDeviceIds: ["phone-device"],
    });
    const handleWebPushResolved = vi.fn(async () => {});
    const context = createContext(undefined, {
      handleRequested: vi.fn(() => false),
      handleResolved: handleWebPushResolved,
      handleExpired: vi.fn(async () => {}),
    });
    const handlePluginApprovalResolved = vi.fn(async () => {});
    const handlePluginIosPushResolved = vi.fn(async () => {});
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder: createForwarder({ handlePluginApprovalResolved }),
      pluginIosPushDelivery: { handleResolved: handlePluginIosPushResolved },
    });
    const request = bindApprovalHandlers(handlers);

    const response = await request.resolve(pending.record.id, {
      kind: "plugin",
      deviceId: "phone-device",
      context,
    });
    expect(response.ok).toBe(true);
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expectResolved(response.result, {
      status: "denied",
      decision: "deny",
      reason: "user",
      presentation: {
        kind: "plugin",
        title: "Plugin permission",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
    const resolvedEvent = { id: pending.record.id, decision: "deny", resolvedBy: "Approval Test" };
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining(resolvedEvent),
      new Set(["approval-client"]),
      { dropIfSlow: true },
    );
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining(resolvedEvent),
    );
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({
      kind: "device",
      id: "phone-device",
    });
    expect(handlePluginApprovalResolved).toHaveBeenCalledTimes(1);
    expect(handlePluginIosPushResolved).toHaveBeenCalledTimes(1);
    for (const delivery of [handlePluginIosPushResolved, handleWebPushResolved]) {
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({ id: pending.record.id, decision: "deny" }),
      );
    }
    expect(recipientOptions(context)?.approvalKind).toBe("plugin");
    expectRecipients(context, "deviceId", "requester-device", "unrelated");

    const terminal = await request(
      "approval.get",
      { id: pending.record.id },
      createClient({ scopes: ["operator.admin"] }),
    );
    expect(validateApprovalGetResult(terminal.result)).toBe(true);
    expect(terminal.result).toMatchObject({ approval: { status: "denied", decision: "deny" } });
  });

  it("returns durable exec truth and continues follow-ups after publication failures", async () => {
    const { databaseOptions, managers } = createFixture();
    const pending = await registerExec(managers.exec, { id: "exec-publication-failures" });
    const context = createContext();
    const broadcastToConnIds = context.broadcastToConnIds as ReturnType<typeof vi.fn>;
    broadcastToConnIds.mockImplementation(() => {
      throw new Error("broadcast unavailable");
    });
    const handleResolved = vi.fn(async () => {
      throw new Error("forwarder unavailable");
    });
    const handleIosResolved = vi.fn(async () => {});
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder: createForwarder({ handleResolved }),
      iosPushDelivery: { handleResolved: handleIosResolved },
    });
    const request = bindApprovalHandlers(handlers);

    const response = await request.resolve(pending.record.id, { context });

    expectResolved(response.result, { status: "denied", decision: "deny", reason: "user" });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("deny");
    expect(await getOperatorApproval({ id: pending.record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
    });
    expect(handleResolved).toHaveBeenCalledTimes(1);
    expect(handleIosResolved).toHaveBeenCalledTimes(1);
    for (const phase of ["broadcast", "forwarder"]) {
      expect(context.logGateway.error).toHaveBeenCalledWith(
        expect.stringContaining(`exec approvals: unified resolve ${phase} failed`),
      );
    }
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "exec",
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
  });

  it("responds with committed truth before a slow resolution forwarder finishes", async () => {
    const { databaseOptions, managers } = createFixture();
    const pending = await registerExec(managers.exec, { id: "exec-slow-resolution-forwarder" });
    const { promise: forwarderPending, resolve: releaseForwarder } = createDeferred();
    const handleResolved = vi.fn(() => forwarderPending);
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder: createForwarder({ handleResolved }),
    });
    const respond = vi.fn();
    const params = { id: pending.record.id, kind: "exec", decision: "deny" };
    const handler = expectDefined(
      handlers["approval.resolve"],
      'handlers["approval.resolve"] test invariant',
    )({
      req: { id: "req-slow-forwarder", type: "req", method: "approval.resolve", params },
      params,
      client: createClient({ deviceId: "reviewer" }),
      context: createContext(),
      isWebchatConnect: () => false,
      respond,
    });
    let handlerFinished = false;
    const handlerCompletion = Promise.resolve(handler).then(() => {
      handlerFinished = true;
    });

    try {
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1), { timeout: 500 });
      expectResolved(respond.mock.calls[0]?.[1], { status: "denied", decision: "deny" });
      await vi.waitFor(() => expect(handleResolved).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(handlerFinished).toBe(true), { timeout: 500 });
    } finally {
      releaseForwarder();
    }
    await handlerCompletion;
  });

  it("uses the live requester connection when filtering legacy resolved events", async () => {
    const { managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "device-less-requester",
      reviewerDeviceIds: ["reviewer-device"],
      requester: {
        connId: "requester-connection",
        deviceId: null,
        clientId: "requester-client",
      },
    });
    const context = createContext();

    const response = await request.resolve(pending.record.id, {
      deviceId: "reviewer-device",
      context,
    });

    expectResolved(response.result, { status: "denied" });
    expect(recipientOptions(context)).toMatchObject({
      approvalKind: "exec",
      record: { requestedByConnId: "requester-connection" },
    });
    expectRecipients(context, "connId", "requester-connection", "unrelated-connection");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("returns the recorded winner to a competing surface without rebroadcasting", async () => {
    const { managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "first-answer-wins",
      reviewerDeviceIds: ["control-ui", "telegram"],
    });
    const context = createContext();

    const [first, second] = await Promise.all([
      request.resolve(pending.record.id, {
        decision: "allow-once",
        deviceId: "control-ui",
        context,
      }),
      request.resolve(pending.record.id, { deviceId: "telegram", context }),
    ]);
    expect([first.result, second.result]).toMatchObject([
      { applied: true, approval: { status: "allowed", decision: "allow-once" } },
      { applied: false, approval: { status: "allowed", decision: "allow-once" } },
    ]);
    expect(validateApprovalResolveResult(first.result)).toBe(true);
    expect(validateApprovalResolveResult(second.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("resolves through the durable transport ref exactly like the canonical id", async () => {
    const { databaseOptions, managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: `approval-${"a".repeat(119)}`,
      requester: { connId: "conn-owner", deviceId: null, clientId: null },
      reviewerDeviceIds: [],
    });
    const durable = await getOperatorApproval({ id: pending.record.id, databaseOptions });
    expect(durable?.resolutionRef).toHaveLength(43);

    const winner = await request.resolve(durable?.resolutionRef, { deviceId: "reviewer-surface" });
    expectResolved(winner.result, { id: pending.record.id, status: "denied", decision: "deny" });
    await expect(pending.decision).resolves.toBe("deny");

    const replay = await request.resolve(pending.record.id, {
      deviceId: "another-surface",
    });
    expectRetained(replay.result, { id: pending.record.id, status: "denied", decision: "deny" });
  });
  it.each([
    { status: "allowed", decision: "allow-once", terminalDecision: "allow-once" },
    { status: "expired", decision: "allow-once", terminalDecision: null },
  ] as const)(
    "returns retained $status truth after the process-local waiter is gone",
    async ({ status, decision, terminalDecision }) => {
      const { databaseOptions, managers } = createFixture();
      const pending = await registerExec(managers.exec, {
        id: `terminal-after-restart-${status}`,
        reviewerDeviceIds: ["later-surface"],
      });
      if (status === "allowed") {
        await managers.exec.resolveDetailed(pending.record.id, terminalDecision, {
          kind: "device",
          id: "first-surface",
        });
      } else {
        await managers.exec.forceDenyDetailed(
          pending.record.id,
          "timeout",
          { kind: "system", id: null },
          status,
          null,
        );
      }
      await expect(pending.decision).resolves.toBe(terminalDecision);

      const restartedManagers = createManagers(databaseOptions);
      const context = createContext();
      const handlers = createHandlers(restartedManagers, databaseOptions);
      const request = bindApprovalHandlers(handlers);
      const response = await request.resolve(pending.record.id, {
        decision,
        deviceId: "later-surface",
        context,
      });

      expectRetained(response.result, { status });
      expect(validateApprovalResolveResult(response.result)).toBe(true);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("atomically denies malformed, mismatched-kind, and disallowed approving verdicts", async () => {
    const { managers, request } = createFixture();
    const disallowed = await registerExec(managers.exec, {
      id: "disallowed-allow-always",
      request: { unavailableDecisions: ["allow-always"] },
    });
    const malformed = await registerPlugin(managers.plugin, {
      id: "plugin:malformed",
      request: { allowedDecisions: ["allow-once"] },
    });
    const mismatchedKind = await registerPlugin(managers.plugin, {
      id: "opaque-plugin-id",
      request: { allowedDecisions: ["allow-once"] },
    });

    for (const [pending, kind, decision] of [
      [disallowed, "exec", "allow-always"],
      [malformed, "plugin", "ACCEPT"],
      [mismatchedKind, "exec", "allow-once"],
    ] as const) {
      const response = await request.resolve(pending.record.id, { kind, decision });
      expectResolved(response.result, {
        status: "denied",
        decision: "deny",
        reason: "malformed-verdict",
      });
      if (pending === mismatchedKind) {
        expect(response.result).toMatchObject({ approval: { presentation: { kind: "plugin" } } });
      }
      await expect(pending.decision).resolves.toBe("deny");
    }
  });

  it("lets the exact deadline beat a malformed verdict", async () => {
    const now = useApprovalClock();
    const { managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "malformed-at-deadline",
      expiresAtMs: 2_000,
    });
    const context = createContext();

    // The lookup observes pending immediately before the deadline; force-deny's
    // store transaction reaches the exact deadline and must reconcile expiry.
    now.mockReturnValueOnce(1_999).mockReturnValue(2_000);

    const response = await request.resolve(pending.record.id, { decision: "ACCEPT", context });

    expectRetained(response.result, { status: "expired", reason: "timeout", resolvedAtMs: 2_000 });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
