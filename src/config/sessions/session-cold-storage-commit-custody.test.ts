import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { withSessionTranscriptDeltaReader } from "./session-transcript-delta-read.js";

it.each(["restore alias", "delta alias", "maintenance replacement"] as const)(
  "refuses %s at the commit grant without changing either database or retained archive bytes",
  async (operation) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const originalPath = state.statePath("stores", "original.sqlite");
      const replacementPath = state.statePath("stores", "replacement.sqlite");
      const alias = state.statePath("stores", "requested.sqlite");
      const detached = `${originalPath}.detached`;
      const original = await createSessionColdStorageFixture(
        originalPath,
        "agent:main:cold-original",
      );
      const replacement = await createSessionColdStorageFixture(
        replacementPath,
        "agent:main:cold-replacement",
      );
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(replacementPath) });
      if (operation !== "maintenance replacement") {
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(originalPath) });
      }
      const before = [original.snapshot(), replacement.snapshot()];
      const archives = [original, replacement].map((fixture) =>
        readSessionColdTranscript(fixture.database(), historicalId),
      );
      const directory = path.join(resolveSessionArtifactDirectory(originalPath), "cold");
      const files = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".jsonl.zst"))
        .map((name) => ({
          pathname: path.join(directory, name),
          bytes: fs.readFileSync(path.join(directory, name)),
        }));
      expect(files.length).toBeGreaterThan(0);
      // Closing the seeded stores checkpoints the replacement before its file is copied.
      await closeOpenClawAgentDatabasesAsync();
      const replacementBytes = fs.readFileSync(replacementPath);
      if (operation !== "maintenance replacement") {
        fs.symlinkSync(originalPath, alias);
      }
      let commitRequests = 0;
      let replaced = false;
      const run = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      const intercept = vi
        .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
        .mockImplementation((params) =>
          run(
            params.expectedMessageType === "reclaimed"
              ? {
                  ...params,
                  onCommitRequest() {
                    commitRequests++;
                    if (operation !== "maintenance replacement") {
                      fs.unlinkSync(alias);
                      fs.symlinkSync(replacementPath, alias);
                    } else {
                      fs.renameSync(originalPath, detached);
                      replaced = true;
                      fs.copyFileSync(replacementPath, originalPath);
                    }
                    params.onCommitRequest();
                  },
                }
              : params,
          ),
        );
      try {
        const target = { ...original.scope, storePath: alias };
        const pending =
          operation === "delta alias"
            ? withSessionTranscriptDeltaReader(target, (reader) => reader.raw({}))
            : operation === "restore alias"
              ? restoreSessionColdTranscript(target)
              : runSessionColdStorageMaintenance({ config: maintenanceConfig(originalPath) });
        await expect(pending).rejects.toThrow(/changed|custody|physical|retired/i);
        expect(commitRequests).toBe(1);
        if (replaced) {
          expect(fs.readFileSync(originalPath)).toEqual(replacementBytes);
        }
      } finally {
        intercept.mockRestore();
        if (replaced) {
          fs.unlinkSync(originalPath);
          fs.renameSync(detached, originalPath);
        }
      }
      expect([original.snapshot(), replacement.snapshot()]).toEqual(before);
      expect(
        [original, replacement].map((fixture) =>
          readSessionColdTranscript(fixture.database(), historicalId),
        ),
      ).toEqual(archives);
      for (const file of files) {
        expect(fs.readFileSync(file.pathname)).toEqual(file.bytes);
      }
    }),
);
