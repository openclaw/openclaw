import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionTranscriptWatermarkAsync } from "./session-transcript-watermark.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

it("carries admitted transcript identity into watermark reads without synchronous path lookup", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:admitted-watermark",
      sessionId: "admitted-watermark",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      { type: "message", id: "question", message: { role: "user", content: "synthetic" } },
    ]);
    const replacement = { ...scope, storePath: state.statePath("replacement.sqlite") };
    await upsertSessionEntryCore(replacement, { sessionId: scope.sessionId, updatedAt: 2 });
    await closeOpenClawAgentDatabaseByPathAsync(replacement.storePath);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    if (!("kind" in databaseClaim) || databaseClaim.kind !== "worker" || !databaseClaim.reader) {
      throw new Error("Expected admitted durable session reader");
    }
    try {
      await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: scope,
          sessionReader: databaseClaim.reader,
          withTranscriptWrite: async (write) => write(),
        },
        async () => {
          await readSessionTranscriptWatermarkAsync(scope);
          const stat = vi.spyOn(fs, "statSync");
          const realpath = vi.spyOn(fs.realpathSync, "native");
          syncBuiltinESMExports();
          try {
            const pending = readSessionTranscriptWatermarkAsync(scope);
            const synchronousCalls = stat.mock.calls.length + realpath.mock.calls.length;
            await expect(pending).resolves.toMatchObject({ maxSeq: 0 });
            expect(synchronousCalls).toBe(0);
          } finally {
            stat.mockRestore();
            realpath.mockRestore();
            syncBuiltinESMExports();
          }
          const originalPath = state.statePath("retained.sqlite");
          await fs.promises.rename(scope.storePath, originalPath);
          try {
            await fs.promises.copyFile(replacement.storePath, scope.storePath);
            await expect(readSessionTranscriptWatermarkAsync(scope)).rejects.toThrow(
              /identity|changed|revoked|current|admission/i,
            );
          } finally {
            await fs.promises.rename(originalPath, scope.storePath);
          }
        },
      );
    } finally {
      await databaseClaim.release();
    }
  }));
