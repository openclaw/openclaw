import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "../../agents/agent-project-settings.js";
import { completePromptCacheObservation } from "../../agents/embedded-agent-runner/prompt-cache-observability.js";
import { beginOpenAIObservation } from "../../agents/embedded-agent-runner/prompt-cache-observability.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearFollowupQueue } from "./queue/state.js";
import {
  clearCommittedSessionResetRuntimeState,
  clearSessionResetRuntimeState,
  prepareSessionResetCleanupGuard,
} from "./session-reset-cleanup.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates(["old-session"]);
  controllerTesting.resetSessionControllerForTest();
  resetDiagnosticRunActivityForTest();
  resetSystemEventsForTest();
});

const replySessionKey = "agent:main:slack:room:1";
function clearArchived(keys = [replySessionKey, "old-session"]) {
  clearSessionResetRuntimeState(keys, {
    agentId: "main",
    sessionKey: replySessionKey,
    activeReplySessionId: "old-session",
    assertCurrent: () => {},
  });
}
function createOperation(sessionId = "old-session") {
  return createReplyOperation({ sessionKey: replySessionKey, sessionId, resetTriggered: false });
}

describe("clearSessionResetRuntimeState", () => {
  it("refreshes prepared settings only for the archived session", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-settings-"));
    const archivedSessionId = `${cwd}:archived`;
    const retainedSessionId = `${cwd}:retained`;
    const params = {
      cwd,
      agentDir: cwd,
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    };
    const settingsPath = path.join(cwd, "settings.json");
    const writeSettings = (keepRecentTokens: number) =>
      fs.writeFile(settingsPath, JSON.stringify({ compaction: { keepRecentTokens } }));
    const readSettings = (sessionId: string) =>
      createPreparedEmbeddedAgentSettingsManager({
        ...params,
        sessionId,
      }).getCompactionKeepRecentTokens();
    try {
      await writeSettings(25_000);
      for (const sessionId of [archivedSessionId, retainedSessionId]) {
        expect(readSettings(sessionId)).toBe(25_000);
      }
      await writeSettings(35_000);

      clearSessionResetRuntimeState([archivedSessionId], {
        agentId: "main",
        sessionKey: "agent:main:settings-reset",
        activeReplySessionId: archivedSessionId,
        assertCurrent: () => {},
      });

      expect(readSettings(archivedSessionId)).toBe(35_000);
      expect(readSettings(retainedSessionId)).toBe(25_000);
    } finally {
      clearPreparedEmbeddedAgentSettings([archivedSessionId, retainedSessionId]);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("disposes prompt projections with the archived session", () => {
    using original = retainEmbeddedSessionPromptState("old-session");
    const state = original.state;

    clearArchived(["old-session"]);

    using replacement = retainEmbeddedSessionPromptState("old-session");
    expect(replacement.state).not.toBe(state);
  });

  it("clears the archived diagnostic baseline when a reply rotates its session", () => {
    const identity = { sessionId: "old-session", sessionKey: replySessionKey };
    beginOpenAIObservation(identity);
    completePromptCacheObservation({ ...identity, usage: { cacheRead: 8_000 } });

    clearCommittedSessionResetRuntimeState({
      previousSessionEntry: { sessionId: identity.sessionId },
      storePath: "/synthetic/reset-observability.sqlite",
      agentId: "main",
      sessionKey: replySessionKey,
      onError: (error) => {
        throw error;
      },
    });

    expect(beginOpenAIObservation(identity).previousCacheRead).toBeNull();
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", withSystemEventOwner({ sessionKey: "alpha" }, "main"));
    enqueueSystemEvent("stale beta", withSystemEventOwner({ sessionKey: "beta" }, "main"));
    enqueueSystemEvent("fresh gamma", withSystemEventOwner({ sessionKey: "gamma" }, "main"));

    clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"], {
      agentId: "main",
      sessionKey: "alpha",
      assertCurrent: () => {},
    });

    expect(peekSystemEvents("agent:main:alpha")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:beta")).toStrictEqual([]);
    expect(peekSystemEvents("agent:main:gamma")).toEqual(["fresh gamma"]);
  });

  it("preserves events owned by other agents during an agent-scoped reset", () => {
    enqueueSystemEvent("main", withSystemEventOwner({ sessionKey: "global" }, "main"));
    enqueueSystemEvent("alpha", withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent("beta", withSystemEventOwner({ sessionKey: "global" }, "beta"));

    clearSessionResetRuntimeState(["global", "agent:beta:global"], {
      agentId: " Alpha ",
      sessionKey: "global",
      assertCurrent: () => {},
    });

    expect(peekSystemEvents("agent:alpha:global")).toEqual([]);
    expect(peekSystemEvents("agent:main:global")).toEqual(["main"]);
    expect(peekSystemEvents("agent:beta:global")).toEqual(["beta"]);
  });

  it("retains archived reply custody until its actual producer returns", async () => {
    const cancel = vi.fn();
    const operation = createOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");
    const raw = createDeferred();
    const producer = raw.promise.then(() => operation.complete());
    try {
      clearArchived();
      expect(cancel).toHaveBeenCalledWith("restart");
      expect(isSessionRunActiveForKey(replySessionKey)).toBe(true);
      expect(() => createOperation("new-session")).toThrow("already active");
      raw.resolve();
      await producer;
      await operation.ownerSettlement;
      const nextOperation = createOperation("new-session");
      expect(nextOperation.sessionId).toBe("new-session");
      nextOperation.complete();
    } finally {
      raw.resolve();
      await producer;
    }
  });

  it.each([
    ["new-session", "running"],
    ["old-session", "queued"],
  ] as const)("preserves %s/%s while clearing archived runtime state", (sessionId, phase) => {
    const operation = createOperation(sessionId);
    if (phase === "running") {
      operation.setPhase(phase);
    }
    clearArchived();
    expect(operation.phase).toBe(phase);
    expect(getSessionControllerOperation(replySessionKey)).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createOperation();
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearArchived();

    expect(replacement).toBeDefined();
    expect(getSessionControllerOperation(replySessionKey)).toBe(replacement);
  });

  it("clears queued sources without cancelling the executing reset turn that requested it", async () => {
    const sessionKey = "agent:main:dashboard:reset-self";
    enqueueSystemEvent("stale", withSystemEventOwner({ sessionKey }, "main"));
    // A `/new` or `/reset` chat turn owns a claimed controller input and runs
    // initSessionState as that claim's operation; its reply signal is the input's.
    const storePath = "/synthetic/reset-self.sqlite";
    const target = captureSessionTarget({ storeScope: storePath, sessionKey, agentId: "main" });
    const resetTurn = reserveSessionControllerSource(sessionKey, {
      policy: { mode: "followup" },
      target,
    });
    const claim = tryClaimSessionControllerTask(resetTurn);
    if (!claim) {
      throw new Error("expected reset turn claim");
    }
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "old-session",
      resetTriggered: true,
      mailboxClaim: claim,
      upstreamAbortSignal: claim.abortController.signal,
    });
    const queued = reserveSessionControllerSource(sessionKey, {
      policy: { mode: "followup" },
      target,
    });
    const onError = vi.fn();
    try {
      withSessionControllerOwner(operation, () =>
        clearCommittedSessionResetRuntimeState({
          previousSessionEntry: { sessionId: "old-session" },
          storePath,
          agentId: "main",
          sessionKey,
          signal: resetTurn.abortSignal,
          onError,
        }),
      );

      expect(onError).not.toHaveBeenCalled();
      expect(resetTurn.abortSignal.aborted).toBe(false);
      expect(queued.abortSignal.aborted).toBe(true);
      expect(peekSystemEvents(sessionKey)).toStrictEqual([]);
      // A clear outside that turn still cancels its claimed input.
      clearFollowupQueue(sessionKey);
      expect(resetTurn.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
  });
});

it("keeps reset cleanup current through metadata writes and refuses a replacement session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "main";
    const sessionKey = "agent:main:reset-cleanup";
    const storePath = resolveOpenClawAgentSqlitePath({ agentId });
    const scope = { agentId, sessionKey, storePath };
    const entry = { sessionId: "before-reset", lifecycleRevision: "original", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const cleanup = await prepareSessionResetCleanupGuard({ ...scope, expectedSession: entry });
    try {
      await replaceSessionEntry(scope, { ...entry, updatedAt: 2, label: "Renamed" });
      expect(() => cleanup.assertCurrent()).not.toThrow();
      await replaceSessionEntry(scope, {
        sessionId: "replacement",
        lifecycleRevision: "replacement",
        updatedAt: 3,
      });
      enqueueSystemEvent("replacement work", withSystemEventOwner({ sessionKey }, agentId));
      expect(() =>
        clearSessionResetRuntimeState([sessionKey, entry.sessionId], {
          agentId,
          sessionKey,
          activeReplySessionId: entry.sessionId,
          assertCurrent: cleanup.assertCurrent,
        }),
      ).toThrow("session changed before cleanup");
      expect(peekSystemEvents(sessionKey)).toEqual(["replacement work"]);
    } finally {
      cleanup.release();
    }
  });
});
