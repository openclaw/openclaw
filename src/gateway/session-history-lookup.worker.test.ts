import zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import * as archiveWorkers from "../config/sessions/session-accessor.sqlite-archive.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionMessagesMatchingIdAsync } from "./session-transcript-readers.js";

afterEach(() => vi.restoreAllMocks());

it("reads process-held incognito history by its key or explicit sentinel path", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "incognito-lookup",
      sessionKey: "agent:main:dashboard:incognito-lookup",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, incognito: true });
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      {
        type: "message",
        id: "private",
        parentId: null,
        message: { role: "user", content: "Private history" },
      },
    ]);
    for (const sessionKey of [scope.sessionKey, undefined]) {
      expect(
        await readSessionMessagesMatchingIdAsync({ ...scope, sessionKey }, "private"),
      ).toMatchObject([{ content: "Private history" }]);
    }
  });
});

it("restores cold lookup bytes in a worker and keeps repeated validation off the caller thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    );
    const read = () => readSessionMessagesMatchingIdAsync(fixture.scope, "history-assistant");
    const expected = await read();
    expect(expected).toMatchObject([{ content: [{ text: "Preserved response" }] }]);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toMatchObject({ archivedTranscripts: 1 });
    const restore = vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation");
    const decode = vi.spyOn(zlib, "zstdDecompressSync");
    const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
    expect(fixture.snapshot()).toEqual(fixture.original);
    expect(restore).toHaveBeenCalledWith(
      expect.objectContaining({
        workerData: expect.objectContaining({ operation: "cold-mutate" }),
      }),
    );
    expect(decode).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();

    // An unchanged projection revision is not proof that every stored payload is valid.
    fixture
      .database()
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
      .run("{malformed", fixture.scope.sessionId);
    await expect(read()).rejects.toThrow();
  });
});
