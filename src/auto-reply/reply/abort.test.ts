// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import { addSubagentFixture } from "./abort-subagent-registry.test-support.js";
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

  async function createAbortConfig(params: { sessionIdsByKey?: Record<string, string> } = {}) {
    const root = abortFixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const cfg: OpenClawConfig = { session: { store: storePath } };
    await Promise.all(
      Object.entries(params.sessionIdsByKey ?? {}).map(([sessionKey, sessionId]) => {
        trackedAbortMemoryKeys.add(sessionKey);
        return replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId, lifecycleRevision: `${sessionId}-revision`, updatedAt: Date.now() },
        );
      }),
    );
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    parentSessionKey?: string;
    from?: string;
    to?: string;
    senderId?: string;
    commandSource?: "native" | "text";
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
    body?: string;
  }) {
    const from = params.from ?? "telegram:123";
    const to = params.to ?? from;
    const { sessionKey, parentSessionKey, targetSessionKey } = params;
    for (const key of [sessionKey, parentSessionKey, targetSessionKey, from, to]) {
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
        From: from,
        To: to,
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
    const followup = createQueueTestRun(
      { prompt: "queued" },
      {
        agentId: resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey }),
        agentDir: path.join(params.root, "agent"),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: path.join(params.root, "session.jsonl"),
        workspaceDir: path.join(params.root, "workspace"),
        config: params.cfg,
      },
    );
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

  function addChild(
    storePath: string,
    requesterSessionKey: string,
    childSessionKey: string,
    runId: string,
    createdAt = Date.now(),
  ) {
    return addSubagentFixture({
      runId,
      childSessionKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childSessionKey }),
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      task: "stop child",
      cleanup: "keep",
      createdAt,
    });
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

  async function storedSession(sessionKey: string, otherSessions: Record<string, string> = {}) {
    const sessionId = otherSessions[sessionKey] ?? sessionKey;
    const fixture = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId, ...otherSessions },
    });
    return {
      ...fixture,
      sessionId,
      stop: (overrides: Partial<Parameters<typeof runStopCommand>[0]> = {}) =>
        runStopCommand({ cfg: fixture.cfg, sessionKey, ...overrides }),
      queue: () => enqueueQueuedFollowupRun({ ...fixture, sessionKey, sessionId }),
      start: (activeSessionId = sessionId) =>
        createActiveAbortOperation(fixture.cfg, sessionKey, activeSessionId),
    };
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
    readAbortSessionEntry: (storePath, sessionKey) => loadSessionEntry({ storePath, sessionKey }),
    acpManagerMocks,
  });

  it("fast-aborts authorized slash stop before queuing even with text commands disabled", async () => {
    const sessionKey = "telegram:123";
    const { cfg, queue, start, stop } = await storedSession(sessionKey);
    cfg.commands = { text: false, ownerAllowFrom: ["telegram:123"] };
    const active = start("session-active");
    queue();
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect((await stop({ senderId: "123", commandSource: "text" })).handled).toBe(true);
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  });

  it("gives a bare stop word the channel-user queue, child, and hook policy", async () => {
    const sessionKey = "telegram:bare-stop";
    const childKey = "agent:main:subagent:bare-stop-child";
    const { storePath, cfg, queue, stop } = await storedSession(sessionKey, {
      [childKey]: childKey,
    });
    cfg.commands = { ownerAllowFrom: ["telegram:123"] };
    queue();
    await addChild(storePath, sessionKey, childKey, "bare-stop-child-run");
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    onTestFinished(() => unregisterInternalHook("command:stop", hook));
    expect(await stop({ senderId: "123", commandSource: "text", body: "stop" })).toMatchObject({
      handled: true,
      stoppedSubagents: 1,
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(hook).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "persists cutoff only for the command's own session (explicit target: %s)",
    async (explicit) => {
      const targetKey = explicit ? "agent:main:telegram:group:123" : "telegram:parent-only";
      const { storePath, stop } = await storedSession(targetKey);
      const messageSid = "56";
      const timestamp = 1234567890001;
      const result = await stop({
        ...(explicit
          ? { sessionKey: "telegram:slash:123", targetSessionKey: targetKey }
          : { sessionKey: undefined, parentSessionKey: targetKey, from: targetKey }),
        messageSid,
        timestamp,
      });

      expect(result.handled).toBe(true);
      const entry = loadSessionEntry({ storePath, sessionKey: targetKey });
      expect(entry?.abortedLastRun).toBe(true);
      expect(entry?.abortCutoffMessageSid).toBe(explicit ? undefined : messageSid);
      expect(entry?.abortCutoffTimestamp).toBe(explicit ? undefined : timestamp);
    },
  );

  it("resolves owner authorization after loading cancellation runtime", async () => {
    const sessionKey = "telegram:123";
    const { cfg, queue, stop } = await storedSession(sessionKey);
    cfg.commands = { ownerAllowFrom: ["telegram:123"] };
    queue();
    const pending = stop({ senderId: "123" });
    cfg.commands.ownerAllowFrom = ["telegram:other-owner"];

    await expect(pending).resolves.toEqual({ handled: false, aborted: false });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it.each(["throws", "unpersisted"] as const)(
    "still stops the resolved target when metadata persistence %s",
    async (failure) => {
      const sessionKey = "agent:main:telegram:group:-1001234567890:topic:99";
      const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
      const sessionId = "persistence-failure-session";
      const { root, cfg } = await createAbortConfig({
        sessionIdsByKey: failure === "throws" ? { [sessionKey]: sessionId } : {},
      });
      const { operation } = createActiveAbortOperation(cfg, sessionKey, sessionId);
      if (failure === "throws") {
        vi.mocked(markSessionAbortTarget).mockRejectedValueOnce(
          new Error("simulated persistence failure"),
        );
      } else {
        const target = { entry: { sessionId, updatedAt: 10 }, sessionId, sessionKey };
        vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(target);
        vi.mocked(markSessionAbortTarget).mockResolvedValueOnce({
          ...target,
          persisted: false,
          persistenceError: "simulated persistence failure",
        });
      }
      enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

      expect((await runStopCommand({ cfg, sessionKey: requestedKey })).handled).toBe(true);
      expect(markSessionAbortTarget).toHaveBeenCalledOnce();
      expect(operation.abortSignal.aborted).toBe(true);
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(getAbortMemory(sessionKey)).toBeUndefined();
    },
  );

  it("fast-abort leaves future prompts untouched when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce(null);
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(null);

    expect((await runStopCommand({ cfg, sessionKey })).handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const { storePath, cfg, sessionId, queue, start, stop } = await storedSession(sessionKey, {
      [childKey]: childKey,
    });
    const { operation, cancel } = start();
    const persistenceStarted = createDeferred();
    const persistence = createDeferred<SessionAbortTargetResult | null>();
    const target = { entry: { sessionId, updatedAt: 10 }, sessionId, sessionKey };
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(target);
    vi.mocked(markSessionAbortTarget).mockImplementationOnce(() => {
      persistenceStarted.resolve();
      return persistence.promise;
    });
    queue();
    await addChild(storePath, sessionKey, childKey, "slow-child-run");
    const child = createActiveAbortOperation(cfg, childKey, childKey, "slow-child-run");
    const resultPromise = stop();
    await persistenceStarted.promise;

    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(child.operation.abortSignal.aborted).toBe(true);
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);

    persistence.resolve({ ...target, persisted: true });
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("propagates a callback failure without a requester", async () => {
    const beforeKill = vi.fn(() => {
      throw new Error("parent cancellation failed");
    });
    await expect(stopSubagentsForRequester({ cfg: {}, beforeKill })).rejects.toThrow(
      "parent cancellation failed",
    );
    expect(beforeKill).toHaveBeenCalledOnce();
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const { cfg, sessionId, queue, stop } = await storedSession(sessionKey);
    const cancel = vi.fn();
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    queue();
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    onTestFinished(() => unregisterInternalHook("command:stop", hook));

    const result = await stop({ from: "telegram:finalizing" });

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
  });

  it.each([false, true])(
    "stops the explicit ACP target's source only when bound (bound=%s)",
    async (bound) => {
      const sourceSessionKey = "agent:main:discord:channel:C3";
      const acpSessionKey = "agent:codex:acp:explicit-target";
      const { start, stop } = await storedSession(sourceSessionKey, {
        [acpSessionKey]: "acp-store-session",
      });
      const { operation: sourceOperation } = start("source-active-session");
      if (bound) {
        bindAcpSessionForTest(acpSessionKey);
      }

      const result = await stop({
        ...(bound ? { sessionKey: undefined, parentSessionKey: sourceSessionKey } : {}),
        from: "discord:C3",
        targetSessionKey: acpSessionKey,
        commandSource: "native",
      });

      expect(result.handled).toBe(true);
      expect(sourceOperation.result).toEqual(
        bound ? { kind: "aborted", code: "aborted_by_user" } : null,
      );
      expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(!bound);
      if (!bound) {
        expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
      }
    },
  );

  it("continues stopping siblings when one termination persistence write fails", async () => {
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const childSessions = {
      [firstChildKey]: "run-persistence-failure-first",
      [secondChildKey]: "run-persistence-failure-second",
    };
    const { root, storePath, cfg } = await storedSession(sessionKey, childSessions);
    const createdAt = Date.now();
    for (const [childKey, runId] of Object.entries(childSessions)) {
      await addChild(storePath, sessionKey, childKey, runId, createdAt);
    }
    const children = Object.entries(childSessions).map(([childSessionKey, sessionId]) => {
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

    expect(await stopSubagentsForRequester({ cfg, requesterSessionKey: sessionKey })).toEqual({
      stopped: 1,
      failed: 1,
    });
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
