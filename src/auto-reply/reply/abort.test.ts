// Tests abort request handling, cutoff persistence, and active run cleanup.
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isSubagentRegistryWriteCommand } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { rowToSubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.store.codec.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  markSessionAbortTarget,
  replaceSessionEntry,
  resolveSessionAbortTarget,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { stopSubagentsForRequester } from "./abort-operation.js";
import { getAbortMemory, isAbortRequestText, setAbortMemory } from "./abort-primitives.js";
import { enqueueAbortFollowupRun } from "./abort-queue.test-support.js";
import {
  addSubagentFixture,
  type SubagentRunFixture,
} from "./abort-subagent-registry.test-support.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { getFollowupQueueDepth } from "./queue.js";
import { clearFollowupQueue } from "./queue/state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortEmbeddedAgentRunOptions = Parameters<
  typeof import("../../agents/embedded-agent-runner/runs.js").abortEmbeddedAgentRun
>[1];

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn<typeof import("../../process/command-queue.js").clearCommandLane>(
    () => 1,
  ),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const acpManagerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn<
    () =>
      | { kind: "none" }
      | {
          kind: "ready";
          sessionKey: string;
          meta: unknown;
        }
  >(() => ({ kind: "none" })),
  cancelSession: vi.fn(async () => {}),
}));

const runtimeAbortMocks = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn<
    (sessionId: string | undefined, opts?: AbortEmbeddedAgentRunOptions) => boolean
  >(() => true),
  resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined as string | undefined),
  isEmbeddedAgentRunActive: vi.fn(() => false),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive: runtimeAbortMocks.isEmbeddedAgentRunActive,
}));
vi.mock("../../agents/embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    markSessionAbortTarget: vi.fn(actual.markSessionAbortTarget),
    resolveSessionAbortTarget: vi.fn(actual.resolveSessionAbortTarget),
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: acpManagerMocks.resolveSession,
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

const abortFixture = useChatAbortRegistryFixture();

describe("abort detection", () => {
  const trackedAbortMemoryKeys = new Set<string>();

  async function writeSessionStore(storePath: string, sessionIdsByKey: Record<string, string>) {
    await Promise.all(
      Object.entries(sessionIdsByKey).map(([sessionKey, sessionId]) =>
        replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() }),
      ),
    );
  }

  async function createAbortConfig(params?: { sessionIdsByKey?: Record<string, string> }) {
    const root = abortFixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      for (const sessionKey of Object.keys(params.sessionIdsByKey)) {
        trackedAbortMemoryKeys.add(sessionKey);
      }
      await writeSessionStore(storePath, params.sessionIdsByKey);
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
        CommandBody: "/stop",
        RawBody: "/stop",
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

  function enqueueQueuedFollowupRun(params: Parameters<typeof enqueueAbortFollowupRun>[0]) {
    trackedAbortMemoryKeys.add(params.sessionKey);
    enqueueAbortFollowupRun(params);
  }

  function expectSessionLaneCleared(sessionKey: string) {
    expect(commandQueueMocks.clearCommandLane.mock.calls.map(([lane]) => lane)).toContain(
      `session:${sessionKey}`,
    );
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

  beforeEach(() => {
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
  });

  afterEach(() => {
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
      clearFollowupQueue(key);
    }
    trackedAbortMemoryKeys.clear();
    vi.restoreAllMocks();
    vi.mocked(markSessionAbortTarget).mockReset();
    vi.mocked(resolveSessionAbortTarget).mockReset();
    replyRunRegistryTesting.resetReplyRunRegistry();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReset().mockReturnValue(true);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("/STOP")).toBe(true);
    expect(isAbortRequestText("/stop!!!")).toBe(true);
    expect(isAbortRequestText("/Stop!!!")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("Stop")).toBe(true);
    expect(isAbortRequestText("STOP")).toBe(true);
    expect(isAbortRequestText("stop action")).toBe(true);
    expect(isAbortRequestText("stop openclaw!!!")).toBe(true);
    expect(isAbortRequestText("停下来")).toBe(true);
    expect(isAbortRequestText("暂停")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(
      isAbortRequestText("/stop@unresolved_bot", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(true);
    expect(
      isAbortRequestText("/stop@unresolved_bot!", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(true);
    expect(
      isAbortRequestText("/queue@unresolved_bot", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(false);
    expect(
      isAbortRequestText("/stop@some_other_bot", {
        botUsername: "openclaw_bot",
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(false);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("wait")).toBe(false);
    expect(isAbortRequestText("please wait")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "199",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "200",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "201",
      }),
    ).toBe(false);
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 1999,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2000,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2001,
      }),
    ).toBe(false);
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
    const sessionId = "session-persistence-failure";
    const activeSessionId = "active-persistence-failure";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const operation = createReplyOperation({
      agentId: "main",
      sessionKey,
      sessionId: activeSessionId,
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
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
    expect(operation.abortSignal.aborted).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(activeSessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort uses resolved target identity when abort metadata save fails", async () => {
    const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "resolved-persistence-failure";
    const { root, cfg } = await createAbortConfig();
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
    vi.mocked(resolveSessionAbortTarget).mockReturnValueOnce({
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
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(canonicalKey)).toBe(0);
    expectSessionLaneCleared(canonicalKey);
    expect(getAbortMemory(canonicalKey)).toBeUndefined();
  });

  it("fast-abort uses abort memory when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce(null);
    vi.mocked(resolveSessionAbortTarget).mockReturnValueOnce(null);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBe(true);
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [childKey]: childSessionId,
        [sessionKey]: sessionId,
      },
    });
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
      vi.mocked(resolveSessionAbortTarget).mockReturnValueOnce({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        sessionId,
        sessionKey,
      });
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await addSubagentFixture({
      runId: "slow-child-run",
      childSessionKey: childKey,
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "slow child",
      cleanup: "keep",
      createdAt: Date.now(),
    });

    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });
    await persistenceStarted;

    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(childSessionId);
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);

    finishPersistence?.();
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("ACP cancel failures do not skip queue and lane cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });
    acpManagerMocks.cancelSession.mockRejectedValueOnce(new Error("cancel failed"));

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("signals the native parent before deferred ACP cancellation and never retargets its replacement", async () => {
    const sessionKey = "agent:main:discord:channel:deferred-acp";
    const acpKey = "agent:main:acp:deferred-acp";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: "native-session", [acpKey]: "acp-session" },
    });
    const native = createReplyOperation({
      sessionKey,
      sessionId: "native-session",
      resetTriggered: false,
    });
    native.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    enqueueQueuedFollowupRun({ root, cfg, sessionId: "native-session", sessionKey });
    bindAcpSessionForTest(acpKey);
    acpManagerMocks.resolveSession.mockReturnValue({ kind: "ready", sessionKey: acpKey, meta: {} });
    const entered = createDeferred();
    const proceed = createDeferred();
    acpManagerMocks.cancelSession.mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
    });
    const pending = runStopCommand({
      cfg,
      sessionKey,
      from: "discord:deferred-acp",
      to: "discord:deferred-acp",
    });
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    try {
      await entered.promise;
      const signaledBeforeAcpWait = native.abortSignal.aborted;
      if (!signaledBeforeAcpWait) {
        // This is still-live parent work, not a post-closure registration claim.
        await registerSubagentRun({
          runId: "during-acp-wait",
          childSessionKey: "agent:main:subagent:during-acp-wait",
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: sessionKey,
          task: "registered before native parent was signaled",
          cleanup: "keep",
          collect: true,
          queued: true,
        });
      }
      const queueClearedBeforeAcpWait = getFollowupQueueDepth(sessionKey) === 0;
      native.complete();
      replacement = createReplyOperation({
        sessionKey,
        sessionId: "replacement-session",
        resetTriggered: false,
      });
      replacement.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
      proceed.resolve();
      await pending;
      expect(
        signaledBeforeAcpWait,
        "native parent must be signaled before the independent ACP await",
      ).toBe(true);
      expect(queueClearedBeforeAcpWait).toBe(true);
      expect(
        replacement.abortSignal.aborted,
        "do not rediscover a replacement parent after ACP settles",
      ).toBe(false);
      expect(
        await getSubagentRunByChildSessionKey("agent:main:subagent:during-acp-wait"),
      ).toBeNull();
    } finally {
      proceed.resolve();
      await pending;
      native.complete();
      replacement?.complete();
    }
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
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReturnValue(false);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
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
    expect(replyRunRegistry.isActive(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
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

  it("does not abort the caller source lane for an unbound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C3";
    const acpSessionKey = "agent:codex:acp:unbound-explicit-target";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

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
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
    });
    sourceOperation.complete();
  });

  it("uses ParentSessionKey as the source lane for a bound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C4";
    const acpSessionKey = "agent:codex:acp:bound-parent-source";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    bindAcpSessionForTest(acpSessionKey);
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

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
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
  });

  it("continues stopping siblings when one termination persistence write fails", async () => {
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const run = (runId: string, childSessionKey: string): SubagentRunFixture => ({
      runId,
      childSessionKey,
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
    let failedTombstone = false;
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, options) =>
        execute(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (isSubagentRegistryWriteCommand(command) && !failedTombstone) {
                  const firstRow = command.input.values.find(
                    (row) => row.run_id === "run-persistence-failure-first",
                  );
                  const first = firstRow && rowToSubagentRunRecord(firstRow);
                  if (
                    first?.execution.status === "terminal" &&
                    first.endedReason === "subagent-killed"
                  ) {
                    failedTombstone = true;
                    throw new Error("sqlite busy");
                  }
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
    );

    await expect(
      stopSubagentsForRequester({
        cfg: {} as OpenClawConfig,
        requesterSessionKey: sessionKey,
      }),
    ).resolves.toEqual({ stopped: 1, failed: 1 });
    expect(failedTombstone).toBe(true);
    expect((await getSubagentRunByChildSessionKey(firstChildKey))?.killIntent).toBeDefined();
    expect((await getSubagentRunByChildSessionKey(secondChildKey))?.endedReason).toBe(
      "subagent-killed",
    );
    expectSessionLaneCleared(firstChildKey);
    expectSessionLaneCleared(secondChildKey);
  });
});
