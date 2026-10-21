// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { isSubagentRegistryWriteCommand } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { rowToSubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.store.codec.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  resolveSessionAbortTarget,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { stopSubagentsForRequester } from "./abort-operation.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import {
  addSubagentFixture,
  type SubagentRunFixture,
} from "./abort-subagent-registry.test-support.js";
import { registerAbortAcpCases } from "./abort.acp.cases.js";
import { registerAbortDetectionCases } from "./abort.detection.cases.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { buildTestCtx } from "./test-ctx.js";

const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async (_params?: unknown) => {}),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    markSessionAbortTarget: vi.fn(actual.markSessionAbortTarget),
    resolveSessionAbortTarget: vi.fn(actual.resolveSessionAbortTarget),
  };
});

vi.mock("../../acp/control-plane/manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../acp/control-plane/manager.js")>()),
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

describe("abort handling", () => {
  const abortFixture = useChatAbortRegistryFixture();
  const trackedAbortMemoryKeys = new Set<string>();

  const operations = new Set<ReplyOperation>();

  function setTrackedAbortMemory(key: string, value: boolean) {
    trackedAbortMemoryKeys.add(key);
    setAbortMemory(key, value);
  }

  function readAbortSessionEntry(storePath: string, sessionKey: string) {
    return loadSessionEntry({ storePath, sessionKey });
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = abortFixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(params?.commandsTextEnabled === undefined
        ? {}
        : { commands: { text: params.commandsTextEnabled } }),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      for (const sessionKey of Object.keys(params.sessionIdsByKey)) {
        trackedAbortMemoryKeys.add(sessionKey);
      }
      await Promise.all(
        Object.entries(params.sessionIdsByKey).map(([sessionKey, sessionId]) =>
          replaceSessionEntry(
            { storePath, sessionKey },
            {
              sessionId,
              lifecycleRevision: `${sessionId}-revision`,
              updatedAt: params.nowMs ?? Date.now(),
            },
          ),
        ),
      );
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    parentSessionKey?: string;
    from: string;
    to: string;
    senderId?: string;
    commandSource?: "native" | "text";
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
    body?: string;
  }) {
    for (const key of [
      params.sessionKey,
      params.parentSessionKey,
      params.targetSessionKey,
      params.from,
      params.to,
    ]) {
      if (key) {
        trackedAbortMemoryKeys.add(key);
      }
    }
    return tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: params.body ?? "/stop",
        RawBody: params.body ?? "/stop",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        From: params.from,
        To: params.to,
        ...(params.sessionKey ? { SessionKey: params.sessionKey } : {}),
        ...(params.parentSessionKey ? { ParentSessionKey: params.parentSessionKey } : {}),
        ...(params.senderId ? { SenderId: params.senderId } : {}),
        ...(params.commandSource ? { CommandSource: params.commandSource } : {}),
        ...(params.targetSessionKey ? { CommandTargetSessionKey: params.targetSessionKey } : {}),
        ...(params.messageSid ? { MessageSid: params.messageSid } : {}),
        ...(typeof params.timestamp === "number" ? { Timestamp: params.timestamp } : {}),
      }),
      cfg: params.cfg,
    });
  }

  function enqueueQueuedFollowupRun(params: {
    root: string;
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
  }) {
    trackedAbortMemoryKeys.add(params.sessionKey);
    const followup = createQueueTestRun({ prompt: "queued" });
    followup.run = {
      ...followup.run,
      agentId: resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey }),
      agentDir: path.join(params.root, "agent"),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: path.join(params.root, "session.jsonl"),
      workspaceDir: path.join(params.root, "workspace"),
      config: params.cfg,
    };
    enqueueFollowupRun(
      params.sessionKey,
      followup,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    return followup;
  }

  function createAbortOperation(cfg: OpenClawConfig, sessionKey: string, sessionId: string) {
    const agentId = resolveSessionAgentId({ config: cfg, sessionKey });
    const operation = createReplyOperation({
      agentId,
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
        sessionKey,
        incarnation: sessionId,
        agentId,
      }),
    });
    operations.add(operation);
    return operation;
  }

  function createActiveAbortOperation(
    cfg: OpenClawConfig,
    sessionKey: string,
    sessionId: string,
    runId?: string,
  ) {
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
    operation.attachBackend({ kind: "embedded", runId, cancel, isStreaming: () => true });
    return { operation, cancel };
  }

  function bindAcpSessionForTest(targetSessionKey: string) {
    vi.spyOn(getSessionBindingService(), "resolveByConversationAsync").mockImplementation(
      async (conversation) => ({
        bindingId: "test-acp-binding",
        targetKind: "session",
        targetSessionKey,
        conversation,
        status: "active",
        boundAt: 0,
      }),
    );
  }

  afterEach(async () => {
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...operations].map((operation) => operation.ownerSettlement));
    operations.clear();
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
      clearSessionQueues([key]);
    }
    trackedAbortMemoryKeys.clear();
    vi.restoreAllMocks();
    vi.mocked(markSessionAbortTarget).mockReset();
    vi.mocked(resolveSessionAbortTarget).mockReset();
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
  });

  registerAbortDetectionCases(setTrackedAbortMemory);
  registerAbortAcpCases({
    createAbortConfig,
    createAbortOperation,
    createActiveAbortOperation,
    enqueueQueuedFollowupRun,
    runStopCommand,
    bindAcpSessionForTest,
    readAbortSessionEntry,
    acpManagerMocks,
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const { cfg } = await createAbortConfig({ commandsTextEnabled: false });
    const result = await runStopCommand({
      cfg,
      sessionKey: "telegram:123",
      from: "telegram:123",
      to: "telegram:123",
    });
    expect(result.handled).toBe(true);
  });

  it("fast-aborts authorized text slash stop commands before they queue", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const activeSessionId = "session-active";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = {
      ...cfg.commands,
      ownerAllowFrom: ["telegram:123"],
    };
    const active = createActiveAbortOperation(cfg, sessionKey, activeSessionId);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      senderId: "123",
      commandSource: "text",
    });

    expect(result.handled).toBe(true);
    expect(active.cancel).toHaveBeenCalledOnce();

    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  });

  it("acknowledges Stop while an accepted backend cancellation remains unsettled", async ({
    signal,
  }) => {
    const sessionKey = "telegram:accepted-cancellation-never-settles";
    const sessionId = "accepted-cancellation-never-settles";
    const { cfg } = await createAbortConfig({ sessionIdsByKey: { [sessionKey]: sessionId } });
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    const cancel = vi.fn();
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    let producerSettled = false;
    void operation.ownerSettlement.then(() => {
      producerSettled = true;
    });
    try {
      const result = await withinTest(
        runStopCommand({ cfg, sessionKey, from: "telegram:123", to: "telegram:123" }),
        signal,
      );
      expect(result).toMatchObject({ handled: true, aborted: true });
      expect(cancel).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledOnce();
      expect(producerSettled).toBe(false);
    } finally {
      operation.complete();
      unregisterInternalHook("command:stop", hook);
      await operation.ownerSettlement;
    }
    expect(producerSettled).toBe(true);
  });

  it("gives a bare stop word the channel-user queue, child, and hook policy", async () => {
    const sessionKey = "telegram:bare-stop";
    const sessionId = "session-bare-stop";
    const childKey = "agent:main:subagent:bare-stop-child";
    const childSessionId = "session-bare-stop-child";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId, [childKey]: childSessionId },
    });
    cfg.commands = { ...cfg.commands, ownerAllowFrom: ["telegram:123"] };
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await addSubagentFixture({
      runId: "bare-stop-child-run",
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "bare stop child",
      cleanup: "keep",
      createdAt: Date.now(),
    });
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);

    try {
      const result = await runStopCommand({
        cfg,
        sessionKey,
        from: "telegram:123",
        to: "telegram:123",
        senderId: "123",
        commandSource: "text",
        body: "stop",
      });

      expect(result).toMatchObject({ handled: true, stoppedSubagents: 1 });
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
        endedReason: "subagent-killed",
        killReconciliation: { suppressTaskDelivery: true },
      });
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      unregisterInternalHook("command:stop", hook);
    }
  });

  it("fast-abort resolves canonical stored session identity before metadata persistence", async () => {
    const storeKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const lookupKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const sessionId = "agent-topic-99";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [storeKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: storeKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: lookupKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(storeKey)).toBe(0);
  });

  it("persists abort cutoff metadata when only ParentSessionKey identifies the command session", async () => {
    const sessionKey = "telegram:parent-only";
    const sessionId = "session-parent-only";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sessionKey,
      from: "telegram:parent-only",
      to: "telegram:parent-only",
      messageSid: "56",
      timestamp: 1234567890001,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, sessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBe("56");
    expect(entry?.abortCutoffTimestamp).toBe(1234567890001);
  });

  it("does not persist cutoff metadata when native /stop targets a different session", async () => {
    const slashSessionKey = "telegram:slash:123";
    const targetSessionKey = "agent:main:telegram:group:123";
    const targetSessionId = "session-target";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [targetSessionKey]: targetSessionId },
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: slashSessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey,
      messageSid: "999",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, targetSessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBeUndefined();
    expect(entry?.abortCutoffTimestamp).toBeUndefined();
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [depth1Key]: depth1SessionId,
        [depth2Key]: depth2SessionId,
      },
    });

    await addSubagentFixture({
      runId: "run-1",
      childSessionKey: depth1Key,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: depth1Key }),
      requesterSessionKey: sessionKey,
      requesterDisplayKey: "telegram:parent",
      task: "orchestrator",
      cleanup: "keep",
      createdAt: Date.now(),
    });
    await addSubagentFixture({
      runId: "run-2",
      childSessionKey: depth2Key,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: depth2Key }),
      requesterSessionKey: depth1Key,
      requesterDisplayKey: depth1Key,
      task: "leaf worker",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(2);
  });

  it("stops a subagent that is paused after yielding", async () => {
    const sessionKey = "telegram:yield-parent";
    const childKey = "agent:main:subagent:yield-child";
    const now = Date.now();
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: "yield-parent", [childKey]: "yield-child" },
    });
    await addSubagentFixture({
      runId: "run-yield-child",
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "paused worker",
      cleanup: "keep",
      createdAt: now - 1_000,
      endedAt: now - 500,
      pauseReason: "sessions_yield",
    });

    const result = await stopSubagentsForRequester({
      cfg,
      requesterSessionKey: sessionKey,
    });

    expect(result).toEqual({ stopped: 1, failed: 0 });
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
  });

  it("cascade stop still traverses an ended current parent when a stale older active row exists", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended-stale";
    const depth2Key = "agent:main:subagent:child-ended-stale:subagent:grandchild-active";
    const now = Date.now();
    const { storePath, cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended-stale",
        [depth2Key]: "session-grandchild-active",
      },
    });

    for (const fixture of [
      {
        runId: "run-stale-parent",
        childSessionKey: depth1Key,
        childAgentId: "main",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "telegram:parent",
        task: "stale orchestrator",
        cleanup: "keep",
        createdAt: now - 2_000,
        startedAt: now - 1_900,
      },
      {
        runId: "run-current-parent",
        childSessionKey: depth1Key,
        childAgentId: "main",
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "telegram:parent",
        task: "current orchestrator",
        cleanup: "keep",
        createdAt: now - 1_000,
        startedAt: now - 900,
        endedAt: now - 500,
        outcome: { status: "ok" },
      },
    ] satisfies SubagentRunFixture[]) {
      await addSubagentFixture({
        ...fixture,
        sessionEntry: loadSessionEntry({ storePath, sessionKey: fixture.childSessionKey }),
      });
    }
    await addSubagentFixture({
      runId: "run-active-child",
      childSessionKey: depth2Key,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: depth2Key }),
      requesterSessionKey: depth1Key,
      requesterDisplayKey: depth1Key,
      task: "leaf worker",
      cleanup: "keep",
      createdAt: now - 400,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expect((await getSubagentRunByChildSessionKey(depth1Key))?.endedReason).not.toBe(
      "subagent-killed",
    );
    expect((await getSubagentRunByChildSessionKey(depth2Key))?.endedReason).toBe("subagent-killed");
  });

  it("stopSubagentsForRequester does not traverse a child that moved to a newer parent", async () => {
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";
    const leafKey = `${childKey}:subagent:leaf`;
    const now = Date.now();
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [oldParentKey]: "old-parent",
        [newParentKey]: "new-parent",
        [childKey]: "shared-child",
        [leafKey]: "leaf",
      },
    });

    await addSubagentFixture({
      runId: "run-shared-child-stale-parent",
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
      requesterSessionKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    });
    await addSubagentFixture({
      runId: "run-leaf-active",
      childSessionKey: leafKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: leafKey }),
      requesterSessionKey: childKey,
      controllerSessionKey: childKey,
      requesterDisplayKey: childKey,
      task: "leaf worker",
      cleanup: "keep",
      createdAt: now - 500,
    });
    await addSubagentFixture({
      runId: "run-shared-child-current-parent",
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
      requesterSessionKey: newParentKey,
      controllerSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 250,
    });

    const result = await stopSubagentsForRequester({
      cfg,
      requesterSessionKey: oldParentKey,
    });

    expect(result).toEqual({ stopped: 0, failed: 0 });
    expect((await getSubagentRunByChildSessionKey(childKey))?.execution.endedAt).toBeUndefined();
    expect((await getSubagentRunByChildSessionKey(leafKey))?.execution.endedAt).toBeUndefined();
  });

  it("resolves owner authorization after loading cancellation runtime", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = { ownerAllowFrom: ["telegram:123"] };
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    const pending = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      senderId: "123",
    });
    cfg.commands.ownerAllowFrom = ["telegram:other-owner"];

    await expect(pending).resolves.toEqual({ handled: false, aborted: false });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it("fast-abort still stops active runs when abort metadata persistence fails", async () => {
    const sessionKey = "telegram:persistence-failure";
    const activeSessionId = "active-persistence-failure";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: activeSessionId },
    });
    const operation = createAbortOperation(cfg, sessionKey, activeSessionId);
    const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    vi.mocked(markSessionAbortTarget).mockRejectedValueOnce(
      new Error("simulated persistence failure"),
    );
    enqueueQueuedFollowupRun({ root, cfg, sessionId: activeSessionId, sessionKey });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(markSessionAbortTarget).toHaveBeenCalledOnce();
    expect(operation.abortSignal.aborted).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort uses resolved target identity when abort metadata save fails", async () => {
    const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "resolved-persistence-failure";
    const { root, cfg } = await createAbortConfig();
    const operation = createAbortOperation(cfg, canonicalKey, sessionId);
    const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce({
      entry: {
        sessionId,
        updatedAt: 10,
      },
      persisted: false,
      persistenceError: "simulated persistence failure",
      sessionId,
      sessionKey: canonicalKey,
    });
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce({
      entry: {
        sessionId,
        updatedAt: 10,
      },
      sessionId,
      sessionKey: canonicalKey,
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: canonicalKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: requestedKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(getFollowupQueueDepth(canonicalKey)).toBe(0);
    expect(getAbortMemory(canonicalKey)).toBeUndefined();
  });

  it("fast-abort leaves future prompts untouched when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce(null);
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(null);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [childKey]: childSessionId,
        [sessionKey]: sessionId,
      },
    });
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
    operation.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
    let finishPersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolveStarted) => {
      vi.mocked(markSessionAbortTarget).mockImplementationOnce(
        () =>
          new Promise<SessionAbortTargetResult | null>((resolvePersistence) => {
            resolveStarted();
            finishPersistence = () => {
              resolvePersistence({
                entry: {
                  sessionId,
                  updatedAt: 10,
                },
                persisted: true,
                sessionId,
                sessionKey,
              });
            };
          }),
      );
      vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        sessionId,
        sessionKey,
      });
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await replaceSessionEntry(
      { storePath, agentId: "main", sessionKey: childKey },
      {
        ...loadSessionEntry({ storePath, agentId: "main", sessionKey: childKey })!,
        lifecycleRevision: "slow-persistence-child-revision",
      },
    );
    await addSubagentFixture({
      runId: "slow-child-run",
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, agentId: "main", sessionKey: childKey }),
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "slow child",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const child = createActiveAbortOperation(cfg, childKey, childSessionId, "slow-child-run");
    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });
    await persistenceStarted;

    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(child.operation.abortSignal.aborted).toBe(true);
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);

    finishPersistence?.();
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("propagates a callback failure without a requester", async () => {
    const requesterSessionKey = undefined;

    const beforeKill = vi.fn(() => {
      throw new Error("parent cancellation failed");
    });
    await expect(
      stopSubagentsForRequester({ cfg: {}, requesterSessionKey, beforeKill }),
    ).rejects.toThrow("parent cancellation failed");
    expect(beforeKill).toHaveBeenCalledOnce();
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const cancel = vi.fn();
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    onTestFinished(() => unregisterInternalHook("command:stop", hook));
    vi.mocked(markSessionAbortTarget).mockClear();

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:finalizing",
      to: "telegram:finalizing",
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(operation.result).toBeNull();
    expect(isSessionRunActiveForKey(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(hook).toHaveBeenCalledOnce();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(getAbortMemory(sessionKey)).toBeUndefined();
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Agent reply is already finalizing and can no longer be aborted.",
    );
    expect(formatAbortReplyText(0, undefined, 1)).toBe(
      "⚙️ Agent was aborted. Cancellation was incomplete for 1 sub-agent. Retry /stop.",
    );
    operation.complete();
  });

  it("does not abort the caller source turn for an unbound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C3";
    const acpSessionKey = "agent:codex:acp:unbound-explicit-target";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const { operation: sourceOperation } = createActiveAbortOperation(
      cfg,
      sourceSessionKey,
      "source-active-session",
    );

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C3",
      to: "discord:C3",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toBeNull();
    expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(true);
    expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
    sourceOperation.complete();
  });

  it("uses ParentSessionKey as the source turn for a bound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C4";
    const acpSessionKey = "agent:codex:acp:bound-parent-source";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const { operation: sourceOperation } = createActiveAbortOperation(
      cfg,
      sourceSessionKey,
      "source-active-session",
    );
    bindAcpSessionForTest(acpSessionKey);

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sourceSessionKey,
      from: "discord:C4",
      to: "discord:C4",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(false);
  });

  it("continues stopping siblings when one termination persistence write fails", async () => {
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: "persistence-failure-parent",
        [firstChildKey]: "run-persistence-failure-first",
        [secondChildKey]: "run-persistence-failure-second",
      },
    });
    for (const childSessionKey of [firstChildKey, secondChildKey]) {
      const scope = { storePath, agentId: "main", sessionKey: childSessionKey };
      const entry = loadSessionEntry(scope)!;
      await replaceSessionEntry(scope, {
        ...entry,
        lifecycleRevision: `${entry.sessionId}-revision`,
      });
    }
    const run = (runId: string, childSessionKey: string): SubagentRunFixture => ({
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, agentId: "main", sessionKey: childSessionKey }),
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "stop despite persistence failure",
      cleanup: "keep",
      createdAt: Date.now(),
    });
    for (const fixture of [
      run("run-persistence-failure-first", firstChildKey),
      run("run-persistence-failure-second", secondChildKey),
    ]) {
      await addSubagentFixture(fixture);
    }
    const children = [firstChildKey, secondChildKey].map((childSessionKey) => {
      const sessionId = loadSessionEntry({ storePath, sessionKey: childSessionKey })!.sessionId;
      const child = createActiveAbortOperation(cfg, childSessionKey, sessionId, sessionId);
      enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: childSessionKey });
      return child;
    });
    let failedTombstone = false;
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (isSubagentRegistryWriteCommand(command) && !failedTombstone) {
        const firstRow = command.input.values.find(
          (row) => row.run_id === "run-persistence-failure-first",
        );
        const first = firstRow && rowToSubagentRunRecord(firstRow);
        if (first?.execution.status === "terminal" && first.endedReason === "subagent-killed") {
          failedTombstone = true;
          throw new Error("sqlite busy");
        }
      }
      return scope.execute(command, executeOptions);
    });

    await expect(
      stopSubagentsForRequester({
        cfg,
        requesterSessionKey: sessionKey,
      }),
    ).resolves.toEqual({ stopped: 1, failed: 1 });
    expect(failedTombstone).toBe(true);
    for (const child of children) {
      expect(child.cancel).toHaveBeenCalledOnce();
      expect(child.operation.abortSignal.aborted).toBe(true);
    }
    expect(getFollowupQueueDepth(firstChildKey)).toBe(0);
    expect(getFollowupQueueDepth(secondChildKey)).toBe(0);
    expect((await getSubagentRunByChildSessionKey(firstChildKey))?.killIntent).toBeDefined();
    expect((await getSubagentRunByChildSessionKey(secondChildKey))?.endedReason).toBe(
      "subagent-killed",
    );
  });
});
