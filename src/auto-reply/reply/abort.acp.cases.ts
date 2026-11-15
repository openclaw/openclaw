import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import type { tryFastAbortFromMessage } from "./abort.js";
import { getFollowupQueueDepth } from "./queue.js";
import type { FollowupRun } from "./queue.js";

type AbortAcpFixtures = {
  createAbortConfig: (params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) => Promise<{ root: string; storePath: string; cfg: OpenClawConfig }>;
  createAbortOperation: (
    cfg: OpenClawConfig,
    sessionKey: string,
    sessionId: string,
  ) => ReplyOperation;
  createActiveAbortOperation: (
    cfg: OpenClawConfig,
    sessionKey: string,
    sessionId: string,
    runId?: string,
  ) => {
    operation: ReplyOperation;
    cancel: () => void;
  };
  enqueueQueuedFollowupRun: (params: {
    root: string;
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
  }) => FollowupRun;
  runStopCommand: (params: {
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
  }) => ReturnType<typeof tryFastAbortFromMessage>;
  bindAcpSessionForTest: (targetSessionKey: string) => void;
  readAbortSessionEntry: (storePath: string, sessionKey: string) => SessionEntry | undefined;
  acpManagerMocks: { cancelSession: (params?: unknown) => Promise<void> };
};
export function registerAbortAcpCases({
  createAbortConfig,
  createAbortOperation,
  createActiveAbortOperation,
  enqueueQueuedFollowupRun,
  runStopCommand,
  bindAcpSessionForTest,
  readAbortSessionEntry,
  acpManagerMocks,
}: AbortAcpFixtures) {
  it.each([false, true])(
    "binding resolution preserves replacement native work and cancels pending input (explicit ACP target: %s)",
    async (explicitTarget) => {
      const sessionKey = "agent:main:telegram:direct:binding-wait";
      const acpKey = "agent:main:acp:binding-wait";
      const sessionId = "native-session";
      const { root, cfg } = await createAbortConfig({
        sessionIdsByKey: { [sessionKey]: sessionId, [acpKey]: "acp-session" },
      });
      const original = createActiveAbortOperation(cfg, sessionKey, sessionId);
      const entered = createDeferred();
      const release = createDeferred();
      vi.spyOn(getSessionBindingService(), "resolveByConversationAsync").mockImplementationOnce(
        async (conversation) => {
          entered.resolve();
          await release.promise;
          return {
            bindingId: "binding-wait",
            targetKind: "session",
            targetSessionKey: acpKey,
            conversation,
            status: "active",
            boundAt: 0,
          };
        },
      );
      const pending = runStopCommand({
        cfg,
        sessionKey,
        from: "telegram:binding-wait",
        to: "telegram:binding-wait",
        ...(explicitTarget ? { targetSessionKey: acpKey } : {}),
      });
      let replacement: ReturnType<typeof createActiveAbortOperation> | undefined;
      try {
        await entered.promise;
        original.operation.complete();
        await original.operation.ownerSettlement;
        replacement = createActiveAbortOperation(cfg, sessionKey, sessionId);
        const followup = enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
        const input = expectDefined(followup.controllerInput, "queued followup");
        expect(getFollowupQueueDepth(sessionKey)).toBe(1);
        expect(input.abortSignal.aborted).toBe(false);
        release.resolve();
        await pending;
        expect(replacement.cancel).not.toHaveBeenCalled();
        expect(replacement.operation.result).toBeNull();
        expect(getFollowupQueueDepth(sessionKey)).toBe(0);
        expect(input.abortSignal.aborted).toBe(true);
        await input.settlement.promise;
      } finally {
        release.resolve();
        original.operation.complete();
        replacement?.operation.complete();
        await pending;
      }
    },
  );

  it("fast-abort of an ACP target also aborts the bound source dispatch turn", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C1";
    const acpSessionKey = "agent:codex:acp:bound-session";
    const { root, cfg } = await createAbortConfig({
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
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    bindAcpSessionForTest(acpSessionKey);

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C1",
      to: "discord:C1",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
  });

  it("fast-abort of a bound ACP target clears captured source input without inventing an active run", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C2";
    const acpSessionKey = "agent:codex:acp:bound-session-stored-source";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-store-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    bindAcpSessionForTest(acpSessionKey);

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C2",
      to: "discord:C2",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
  });

  it("fast-abort from an ACP-bound source conversation aborts source and bound ACP turns", async () => {
    const sourceSessionKey = "agent:main:telegram:direct:source-1";
    const acpSessionKey = "agent:codex:acp:bound-source-stop";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-active-session",
        [acpSessionKey]: "acp-active-session",
      },
    });
    const { operation: sourceOperation } = createActiveAbortOperation(
      cfg,
      sourceSessionKey,
      "source-active-session",
    );
    const acpOperation = createAbortOperation(cfg, acpSessionKey, "acp-active-session");
    acpOperation.attachBackend({
      kind: "cli",
      cancel: () => queueMicrotask(() => acpOperation.complete()),
      isStreaming: () => true,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-active-session",
      sessionKey: acpSessionKey,
    });
    bindAcpSessionForTest(acpSessionKey);

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "telegram:source-1",
      to: "telegram:source-1",
      messageSid: "77",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(acpOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(false);
    expect(isSessionRunActiveForKey(acpSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
    const sourceEntry = readAbortSessionEntry(storePath, sourceSessionKey);
    const acpEntry = readAbortSessionEntry(storePath, acpSessionKey);
    expect(sourceEntry?.abortCutoffMessageSid).toBe("77");
    expect(sourceEntry?.abortCutoffTimestamp).toBe(1234567890000);
    expect(acpEntry?.abortCutoffMessageSid).toBeUndefined();
    expect(acpEntry?.abortCutoffTimestamp).toBeUndefined();
  });

  it("ACP backend failure does not skip captured mailbox cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    const cancel = vi.fn(() => {
      queueMicrotask(() => operation.complete());
      throw new Error("cancel failed");
    });
    operation.attachBackend({ kind: "cli", cancel, isStreaming: () => true });
    const followup = enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

    await expect(
      runStopCommand({
        cfg,
        sessionKey,
        from: "telegram:123",
        to: "telegram:123",
        targetSessionKey: sessionKey,
      }),
    ).rejects.toThrow("cancel failed");

    expect(cancel).toHaveBeenCalledOnce();
    expect(operation.abortSignal.aborted).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(followup.controllerInput?.abortSignal.aborted).toBe(true);
    await followup.controllerInput?.settlement.promise;
    expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
  });

  it("plain-language stop leaves an idle ACP backend to /acp cancel", async () => {
    const sessionKey = "agent:codex:acp:idle";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: "idle-acp-session" },
    });
    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
      commandSource: "text",
      body: "stop",
    });
    expect(result).toMatchObject({ handled: true, aborted: false });
    expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
  });

  it("signals the native parent before deferred ACP cancellation and never retargets its replacement", async () => {
    const sessionKey = "agent:main:discord:channel:deferred-acp";
    const acpKey = "agent:main:acp:deferred-acp";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: "native-session", [acpKey]: "acp-session" },
    });
    const { operation: native } = createActiveAbortOperation(cfg, sessionKey, "native-session");
    const acp = createAbortOperation(cfg, acpKey, "acp-session");
    const releaseAcpExecution = acp.retainExecution();
    const entered = createDeferred();
    const cancelAcp = vi.fn(() => {
      entered.resolve();
      queueMicrotask(() => acp.complete());
    });
    acp.attachBackend({ kind: "cli", cancel: cancelAcp, isStreaming: () => true });
    const followup = enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "native-session",
      sessionKey,
    });
    bindAcpSessionForTest(acpKey);
    let settled = false;
    const pending = runStopCommand({
      cfg,
      sessionKey,
      from: "discord:deferred-acp",
      to: "discord:deferred-acp",
    }).finally(() => {
      settled = true;
    });
    let replacement: ReplyOperation | undefined;
    try {
      await entered.promise;
      const signaledBeforeAcpWait = native.abortSignal.aborted;
      if (!signaledBeforeAcpWait) {
        // A regression leaves real parent work alive during the ACP wait.
        await registerSubagentRun({
          runId: "during-acp-wait",
          childSessionKey: "agent:main:subagent:during-acp-wait",
          childAgentId: "main",
          sessionEntry: { sessionId: "during-acp-wait-session" },
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
      await native.ownerSettlement;
      await followup.controllerInput?.settlement.promise;
      replacement = createActiveAbortOperation(cfg, sessionKey, "replacement-session").operation;
      expect(settled).toBe(false);
      expect(acp.abortSignal.aborted).toBe(true);
      releaseAcpExecution();
      await pending;
      expect(
        signaledBeforeAcpWait,
        "native parent must be signaled before the independent ACP wait",
      ).toBe(true);
      expect(queueClearedBeforeAcpWait).toBe(true);
      expect(
        replacement.abortSignal.aborted,
        "do not rediscover a replacement parent after ACP settles",
      ).toBe(false);
      expect(
        await getSubagentRunByChildSessionKey("agent:main:subagent:during-acp-wait"),
      ).toBeNull();
      expect(cancelAcp).toHaveBeenCalledOnce();
      expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
    } finally {
      releaseAcpExecution();
      native.complete();
      acp.complete();
      replacement?.complete();
      await pending;
    }
  });
}
