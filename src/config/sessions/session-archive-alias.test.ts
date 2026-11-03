import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { readSessionTaskArchivePageReadOnly } from "./session-accessor.sqlite-history.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { readSessionEntryInWorker } from "./session-entry-read-runtime.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";

it("archives and reads a session through a state directory alias", async () => {
  await withOpenClawTestState({ label: "session-archive-alias" }, async (state) => {
    const stateAlias = `${fs.realpathSync.native(state.stateDir)}-alias`;
    fs.symlinkSync(fs.realpathSync.native(state.stateDir), stateAlias, "dir");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateAlias);
    try {
      const runId = randomUUID();
      const scope = {
        agentId: "main",
        sessionKey: `agent:main:cron:${randomUUID()}`,
        sessionId: randomUUID(),
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await appendTranscriptEvent(scope, { type: "session", version: 3, id: scope.sessionId });
      await appendTranscriptMessage(scope, {
        eventId: "input",
        parentId: null,
        message: { role: "user", content: "Synthetic cron request" },
      });
      await appendTranscriptMessage(scope, {
        eventId: "answer",
        parentId: "input",
        message: { role: "assistant", content: "Synthetic cron answer", __openclaw: { runId } },
      });
      await waitForSessionTranscriptProjection(scope);
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
      const deleted = await deleteSessionEntryLifecycle({
        storePath: scope.storePath,
        archiveTranscript: true,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });
      expect(deleted.deleted).toBe(true);
      expect(deleted.archivedTranscripts).toEqual([
        expect.objectContaining({ sessionId: scope.sessionId, archivedPath: expect.any(String) }),
      ]);
      expect(await readSessionEntryInWorker(scope)).toBeUndefined();
      expect(await loadTranscriptEvents(scope)).toEqual([]);
      const page = await readSessionTaskArchivePageReadOnly(scope, { runId, limit: 1 });
      expect(page?.entries).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ id: "answer" }),
        }),
      ]);
    } finally {
      // The alias lives in the temporary home and is removed with the test state.
      vi.unstubAllEnvs();
    }
  });
});
