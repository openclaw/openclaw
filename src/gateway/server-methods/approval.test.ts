// Unified approval handlers test safe projections, authorization, and one-shot resolution.
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
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
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
  cleanupApprovalHandlerFixtures,
  createClient,
  createDatabaseOptions,
  createManagers,
  getOperatorApproval,
  invoke,
  registerExec,
  tempDirs,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import {
  corruptDurableApprovalPresentation,
  createContext,
  deleteDurableApproval,
} from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: prepareApprovalChannelCustodyMock,
}));

function createHandlers(
  managers: ReturnType<typeof createManagers>,
  databaseOptions: OpenClawStateDatabaseOptions,
  options: Omit<
    Parameters<typeof createApprovalHandlers>[0],
    "execApprovalManager" | "pluginApprovalManager" | "databaseOptions"
  > = {},
) {
  return createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    databaseOptions,
    ...options,
  });
}

async function registerPlugin(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  params: {
    id: string;
    request?: Partial<PluginApprovalRequestPayload>;
    reviewerDeviceIds?: string[];
  },
) {
  const record = manager.create(
    {
      title: "Plugin permission",
      description: "Allow one guarded plugin operation",
      severity: "warning",
      pluginId: "example-plugin",
      toolName: "example-tool",
      agentId: "main",
      sessionKey: "agent:main:child",
      ...params.request,
    },
    600_000,
    params.id,
  );
  record.requestedByDeviceId = "requester-device";
  record.requestedByClientId = "requester-client";
  record.requestedByDeviceTokenAuth = true;
  record.approvalReviewerDeviceIds = params.reviewerDeviceIds ?? ["reviewer"];
  const decision = (await manager.register(record, 600_000)).decision;
  return { record, decision };
}

function approvalFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !("approval" in result)) {
    throw new Error("missing approval response");
  }
  return (result as { approval: Record<string, unknown> }).approval;
}

describe("unified approval handlers", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });

  it("returns mapped terminal history with attribution and a next cursor", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const first = await registerExec(managers.exec, { id: "history:first" });
    const second = await registerPlugin(managers.plugin, { id: "history:second" });
    const handlers = createHandlers(managers, databaseOptions);
    for (const [id, kind] of [
      [first.record.id, "exec"],
      [second.record.id, "plugin"],
    ] as const) {
      const response = await invoke({
        handlers,
        method: "approval.resolve",
        body: { id, kind, decision: "deny" },
        client: createClient({ deviceId: "reviewer" }),
      });
      expect(response.ok).toBe(true);
    }

    const firstPage = await invoke({
      handlers,
      method: "approval.history",
      body: { limit: 1 },
      client: createClient({ deviceId: "reviewer" }),
      context: createContext("/operator/"),
    });
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

    const secondPage = await invoke({
      handlers,
      method: "approval.history",
      body: { cursor: firstResult.nextCursor, limit: 1 },
      client: createClient({ deviceId: "reviewer" }),
    });
    expect(secondPage.ok).toBe(true);
    expect((secondPage.result as ApprovalHistoryResult).items).toHaveLength(1);
    expect((secondPage.result as ApprovalHistoryResult).nextCursor).toBeUndefined();
  });

  it("cancels only approvals owned by the aborted active run", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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

    const handlers = createHandlers(managers, databaseOptions);
    const replay = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: aborted.record.id, kind: "exec", decision: "allow-once" },
      client: createClient({ deviceId: "later-surface" }),
      context,
    });
    expect(replay.result).toMatchObject({
      applied: false,
      approval: {
        id: aborted.record.id,
        status: "cancelled",
        reason: "run-aborted",
      },
    });
  });

  it("cancels exact exec and plugin authority without touching a same-run successor", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const oldAuthority = {
      kind: "local" as const,
      operationalRunInstance: { instanceId: "instance-old", runId: "run-reused" },
      lifecycleGeneration: "generation-1",
      claimId: "claim-old",
    };
    const successorAuthority = {
      kind: "local" as const,
      operationalRunInstance: { instanceId: "instance-new", runId: "run-reused" },
      lifecycleGeneration: "generation-1",
      claimId: "claim-new",
    };
    const oldExec = await registerExec(managers.exec, {
      id: "old-exec-authority",
      request: { runId: "run-reused" },
    });
    const successorExec = await registerExec(managers.exec, {
      id: "successor-exec-authority",
      request: { runId: "run-reused" },
    });
    const oldPlugin = await registerPlugin(managers.plugin, {
      id: "old-plugin-authority",
      request: { runId: "run-reused" },
    });
    const successorPlugin = await registerPlugin(managers.plugin, {
      id: "successor-plugin-authority",
      request: { runId: "run-reused" },
    });
    oldExec.record.agentRuntimeDelegatedAuthority = oldAuthority;
    oldPlugin.record.agentRuntimeDelegatedAuthority = oldAuthority;
    successorExec.record.agentRuntimeDelegatedAuthority = successorAuthority;
    successorPlugin.record.agentRuntimeDelegatedAuthority = successorAuthority;

    expect(
      await cancelAgentRuntimeBoundApprovals({
        authority: oldAuthority,
        reason: "permission-change",
        manager: managers.exec,
        publish: () => {},
      }),
    ).toBe(1);
    expect(
      await cancelAgentRuntimeBoundApprovals({
        authority: oldAuthority,
        reason: "permission-change",
        manager: managers.plugin,
        publish: () => {},
      }),
    ).toBe(1);

    await expect(oldExec.decision).resolves.toBeNull();
    await expect(oldPlugin.decision).resolves.toBeNull();
    expect(oldExec.record.resolvedBy).toBe("permission-change");
    expect(oldPlugin.record.resolvedBy).toBe("permission-change");
    expect(
      (await managers.exec.getSnapshot(successorExec.record.id))?.resolvedAtMs,
    ).toBeUndefined();
    expect(
      (await managers.plugin.getSnapshot(successorPlugin.record.id))?.resolvedAtMs,
    ).toBeUndefined();
    await managers.exec.resolve(successorExec.record.id, "deny");
    await managers.plugin.resolve(successorPlugin.record.id, "deny");
    await successorExec.decision;
    await successorPlugin.decision;
  });

  it("resolves a durable deny without reconstructing a raw legacy request", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        presentation: { kind: "exec", commandText: "durable safe preview" },
      },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("expires durable state on a forward-clock lookup and settles the live waiter", async () => {
    installTestApprovalClock();
    const get = operatorApprovalStore.getOperatorApprovalDetailed;
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation((params) =>
      get({ ...params, nowMs: Date.now() }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "forward-clock-expiry",
      expiresAtMs: 2_000,
    });
    const handlers = createHandlers(managers, databaseOptions);
    now.mockReturnValue(2_000);

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response.result).toMatchObject({
      approval: { status: "expired", reason: "timeout", resolvedAtMs: 2_000 },
    });
    expect(validateApprovalGetResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
  });

  it.each([
    ["missing", deleteDurableApproval],
    ["corrupt", corruptDurableApprovalPresentation],
  ] as const)("fails a live waiter closed when durable state is %s", async (_label, mutate) => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, { id: `durable-${_label}` });
    mutate(databaseOptions, pending.record.id);
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

  it("settles the canonical live waiter when a transport-ref lookup finds corrupt state", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, { id: "corrupt-through-transport-ref" });
    const durable = await getOperatorApproval({ id: pending.record.id, databaseOptions });
    if (!durable) {
      throw new Error("expected durable approval");
    }
    corruptDurableApprovalPresentation(databaseOptions, pending.record.id);
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable.resolutionRef, kind: "exec", decision: "allow-once" },
      client: createClient({ deviceId: "telegram" }),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toMatchObject({
      status: "denied",
      terminalReason: "storage-corrupt",
    });
  });

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
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ deviceId: "reviewer" }),
    });

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
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved: vi.fn(async () => {}),
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved,
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder,
      pluginIosPushDelivery: { handleResolved: handlePluginIosPushResolved },
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "plugin", decision: "deny" },
      client: createClient({ deviceId: "phone-device" }),
      context,
    });
    expect(response.ok).toBe(true);
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        reason: "user",
        presentation: {
          kind: "plugin",
          title: "Plugin permission",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    await expect(pending.decision).resolves.toBe("deny");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(context.broadcastToConnIds).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining({
        id: pending.record.id,
        decision: "deny",
        resolvedBy: "Approval Test",
      }),
      new Set(["approval-client"]),
      { dropIfSlow: true },
    );
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({
        id: pending.record.id,
        decision: "deny",
        resolvedBy: "Approval Test",
      }),
    );
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({
      kind: "device",
      id: "phone-device",
    });
    expect(handlePluginApprovalResolved).toHaveBeenCalledTimes(1);
    expect(handlePluginIosPushResolved).toHaveBeenCalledTimes(1);
    expect(handlePluginIosPushResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
    expect(handleWebPushResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
    const recipientLookup = context.getApprovalClientConnIds as ReturnType<typeof vi.fn>;
    const recipientOptions = recipientLookup.mock.calls[0]?.[0] as
      | {
          approvalKind?: string;
          filter?: (
            client: GatewayRequestHandlerOptions["client"],
            record?: { id: string },
          ) => boolean;
          record?: { id: string };
        }
      | undefined;
    expect(recipientOptions?.approvalKind).toBe("plugin");
    expect(
      recipientOptions?.filter?.(createClient({ deviceId: "unrelated" }), recipientOptions.record),
    ).toBe(false);
    expect(
      recipientOptions?.filter?.(
        createClient({ deviceId: "requester-device" }),
        recipientOptions.record,
      ),
    ).toBe(true);

    const terminal = await invoke({
      handlers,
      method: "approval.get",
      body: { id: pending.record.id },
      client: createClient({ scopes: ["operator.admin"] }),
    });
    expect(validateApprovalGetResult(terminal.result)).toBe(true);
    expect(approvalFromResult(terminal.result)).toMatchObject({
      status: "denied",
      decision: "deny",
    });
  });

  it("returns durable exec truth and continues follow-ups after publication failures", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved,
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder,
      iosPushDelivery: { handleResolved: handleIosResolved },
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("deny");
    expect(await getOperatorApproval({ id: pending.record.id, databaseOptions })).toMatchObject({
      status: "denied",
      decision: "deny",
    });
    expect(handleResolved).toHaveBeenCalledTimes(1);
    expect(handleIosResolved).toHaveBeenCalledTimes(1);
    expect(context.logGateway.error).toHaveBeenCalledWith(
      expect.stringContaining("exec approvals: unified resolve broadcast failed"),
    );
    expect(context.logGateway.error).toHaveBeenCalledWith(
      expect.stringContaining("exec approvals: unified resolve forwarder failed"),
    );
    expect(context.approvalEvents!.publishResolved).toHaveBeenCalledWith(
      "exec",
      expect.objectContaining({ id: pending.record.id, decision: "deny" }),
    );
  });

  it("responds with committed truth before a slow resolution forwarder finishes", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, { id: "exec-slow-resolution-forwarder" });
    const { promise: forwarderPending, resolve: releaseForwarder } = createDeferred();
    const handleResolved = vi.fn(() => forwarderPending);
    const forwarder = {
      handleRequested: vi.fn(async () => false),
      handleResolved,
      handlePluginApprovalRequested: vi.fn(async () => false),
      handlePluginApprovalResolved: vi.fn(async () => {}),
      stop: vi.fn(),
    } satisfies ExecApprovalForwarder;
    const handlers = createHandlers(managers, databaseOptions, {
      forwarder,
    });
    const respond = vi.fn();
    const handler = expectDefined(
      handlers["approval.resolve"],
      'handlers["approval.resolve"] test invariant',
    )({
      req: {
        id: "req-slow-forwarder",
        type: "req",
        method: "approval.resolve",
        params: { id: pending.record.id, kind: "exec", decision: "deny" },
      },
      params: { id: pending.record.id, kind: "exec", decision: "deny" },
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
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        applied: true,
        approval: { status: "denied", decision: "deny" },
      });
      await vi.waitFor(() => expect(handleResolved).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(handlerFinished).toBe(true), { timeout: 500 });
    } finally {
      releaseForwarder();
    }
    await handlerCompletion;
  });

  it("uses the live requester connection when filtering legacy resolved events", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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
    const handlers = createHandlers(managers, databaseOptions);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-device" }),
      context,
    });

    expect(response.result).toMatchObject({ applied: true, approval: { status: "denied" } });
    const recipientLookup = context.getApprovalClientConnIds as ReturnType<typeof vi.fn>;
    const recipientOptions = recipientLookup.mock.calls[0]?.[0] as
      | {
          approvalKind?: string;
          filter?: (
            client: GatewayRequestHandlerOptions["client"],
            record?: { requestedByConnId?: string | null },
          ) => boolean;
          record?: { requestedByConnId?: string | null };
        }
      | undefined;
    expect(recipientOptions?.approvalKind).toBe("exec");
    expect(recipientOptions?.record?.requestedByConnId).toBe("requester-connection");
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "requester-connection" }),
        recipientOptions.record,
      ),
    ).toBe(true);
    expect(
      recipientOptions?.filter?.(
        createClient({ connId: "unrelated-connection" }),
        recipientOptions.record,
      ),
    ).toBe(false);
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("returns the recorded winner to a competing surface without rebroadcasting", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "first-answer-wins",
      reviewerDeviceIds: ["control-ui", "telegram"],
    });
    const context = createContext();
    const handlers = createHandlers(managers, databaseOptions);

    const [first, second] = await Promise.all([
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "allow-once" },
        client: createClient({ deviceId: "control-ui" }),
        context,
      }),
      invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision: "deny" },
        client: createClient({ deviceId: "telegram" }),
        context,
      }),
    ]);
    expect([first.result, second.result]).toEqual([
      expect.objectContaining({
        applied: true,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
      expect.objectContaining({
        applied: false,
        approval: expect.objectContaining({ status: "allowed", decision: "allow-once" }),
      }),
    ]);
    expect(validateApprovalResolveResult(first.result)).toBe(true);
    expect(validateApprovalResolveResult(second.result)).toBe(true);
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(context.broadcastToConnIds).toHaveBeenCalledTimes(1);
  });

  it("resolves through the durable transport ref exactly like the canonical id", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    // No explicit reviewer binding: any authorized reviewer device may resolve,
    // and the opaque transport ref must behave exactly like the canonical id.
    const pending = await registerExec(managers.exec, {
      id: `approval-${"a".repeat(119)}`,
      requester: { connId: "conn-owner", deviceId: null, clientId: null },
      reviewerDeviceIds: [],
    });
    const durable = await getOperatorApproval({ id: pending.record.id, databaseOptions });
    expect(durable?.resolutionRef).toHaveLength(43);
    const handlers = createHandlers(managers, databaseOptions);

    const winner = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: durable?.resolutionRef, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "reviewer-surface" }),
    });
    expect(winner.result).toMatchObject({
      applied: true,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
    await expect(pending.decision).resolves.toBe("deny");

    const replayByCanonicalId = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "deny" },
      client: createClient({ deviceId: "another-surface" }),
    });
    expect(replayByCanonicalId.result).toMatchObject({
      applied: false,
      approval: { id: pending.record.id, status: "denied", decision: "deny" },
    });
  });
  it.each([
    { status: "allowed", decision: "allow-once", terminalDecision: "allow-once" },
    { status: "expired", decision: "allow-once", terminalDecision: null },
  ] as const)(
    "returns retained $status truth after the process-local waiter is gone",
    async ({ status, decision, terminalDecision }) => {
      const databaseOptions = createDatabaseOptions();
      const managers = createManagers(databaseOptions);
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
      const handlers = createApprovalHandlers({
        execApprovalManager: restartedManagers.exec,
        pluginApprovalManager: restartedManagers.plugin,
        databaseOptions,
      });
      const response = await invoke({
        handlers,
        method: "approval.resolve",
        body: { id: pending.record.id, kind: "exec", decision },
        client: createClient({ deviceId: "later-surface" }),
        context,
      });

      expect(response.result).toMatchObject({
        applied: false,
        approval: {
          status,
        },
      });
      expect(validateApprovalResolveResult(response.result)).toBe(true);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("atomically denies malformed, mismatched-kind, and disallowed approving verdicts", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
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
    const handlers = createHandlers(managers, databaseOptions);
    const client = createClient({ deviceId: "reviewer" });

    const disallowedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: disallowed.record.id, kind: "exec", decision: "allow-always" },
      client,
    });
    expect(disallowedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(disallowed.decision).resolves.toBe("deny");

    const malformedResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: malformed.record.id, kind: "plugin", decision: "ACCEPT" },
      client,
    });
    expect(malformedResponse.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(malformed.decision).resolves.toBe("deny");

    const mismatchedKindResponse = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: mismatchedKind.record.id, kind: "exec", decision: "allow-once" },
      client,
    });
    expect(mismatchedKindResponse.result).toMatchObject({
      applied: true,
      approval: {
        status: "denied",
        decision: "deny",
        reason: "malformed-verdict",
        presentation: { kind: "plugin" },
      },
    });
    await expect(mismatchedKind.decision).resolves.toBe("deny");
  });

  it("lets the exact deadline beat a malformed verdict", async () => {
    installTestApprovalClock();
    const get = operatorApprovalStore.getOperatorApprovalDetailed;
    vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailed").mockImplementation((params) =>
      get({ ...params, nowMs: Date.now() }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "malformed-at-deadline",
      expiresAtMs: 2_000,
    });
    const context = createContext();
    const handlers = createHandlers(managers, databaseOptions);
    // The lookup observes pending immediately before the deadline; force-deny's
    // store transaction reaches the exact deadline and must reconcile expiry.
    now.mockReturnValueOnce(1_999).mockReturnValue(2_000);

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: { id: pending.record.id, kind: "exec", decision: "ACCEPT" },
      client: createClient({ deviceId: "reviewer" }),
      context,
    });

    expect(response.result).toMatchObject({
      applied: false,
      approval: {
        status: "expired",
        reason: "timeout",
        resolvedAtMs: 2_000,
      },
    });
    expect(validateApprovalResolveResult(response.result)).toBe(true);
    await expect(pending.decision).resolves.toBeNull();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
