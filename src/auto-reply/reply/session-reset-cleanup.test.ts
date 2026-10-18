// Tests session reset cleanup for stale files and persisted state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPreparedEmbeddedAgentSettings,
  createPreparedEmbeddedAgentSettingsManager,
} from "../../agents/agent-project-settings.js";
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
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import {
  clearSessionResetRuntimeState,
  prepareSessionResetCleanupGuard,
} from "./session-reset-cleanup.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates(["old-session"]);
  replyRunTesting.resetReplyRunRegistry();
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
    state.toolResults.frozen.add("sent-tool-result");

    clearArchived(["old-session"]);

    using replacement = retainEmbeddedSessionPromptState("old-session");
    expect(replacement.state).not.toBe(state);
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

  it("releases active reply work owned by the archived reset session id", () => {
    const cancel = vi.fn();
    const operation = createOperation();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearArchived();

    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunRegistry.isActive(replySessionKey)).toBe(false);
    const nextOperation = createOperation("new-session");
    expect(nextOperation.sessionId).toBe("new-session");
  });

  it("does not clear a fresh active reply under the same key when only the archived id is reset", () => {
    const operation = createOperation("new-session");
    operation.setPhase("running");

    clearArchived();

    expect(replyRunRegistry.get(replySessionKey)).toBe(operation);
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
    expect(replyRunRegistry.get(replySessionKey)).toBe(replacement);
  });

  it("leaves queued reservations for the archived id so session init can rebind them", () => {
    const operation = createOperation();

    clearArchived();

    expect(operation.phase).toBe("queued");
    expect(replyRunRegistry.get(replySessionKey)).toBe(operation);
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
