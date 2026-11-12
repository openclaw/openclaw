import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
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

it("checks hot transcript access without synchronous filesystem work on the host", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    const events = loadTranscriptEventsSync(fixture.scope);
    const calls: string[] = [];
    const record = (name: string) => {
      const stack = new Error().stack ?? "";
      if (stack.includes("session-cold-storage.ts")) {
        calls.push(name);
      }
    };
    const stat = fs.statSync;
    const realpath = fs.realpathSync.native;
    const spies = [
      vi.spyOn(fs, "statSync").mockImplementation((...args) => {
        record("statSync");
        return Reflect.apply(stat, fs, args);
      }),
      vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) => {
        record("realpathSync.native");
        return Reflect.apply(realpath, fs.realpathSync, args);
      }),
    ];
    syncBuiltinESMExports();
    try {
      await restoreSessionColdTranscript(fixture.scope);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
      syncBuiltinESMExports();
    }
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(events);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
    expect(calls).toEqual([]);
  }));

it("refuses archived restoration when its database is replaced at the commit grant", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) });
    const before = fixture.snapshot();
    const detached = storePath + ".detached";
    let replaced = false;
    const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
    const spy = vi
      .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
      .mockImplementation((params) =>
        original(
          params.expectedMessageType === "reclaimed"
            ? {
                ...params,
                onCommitRequest() {
                  fs.renameSync(storePath, detached);
                  fs.writeFileSync(storePath, "replacement");
                  replaced = true;
                  params.onCommitRequest();
                },
              }
            : params,
        ),
      );
    try {
      await expect(restoreSessionColdTranscript(fixture.scope)).rejects.toThrow();
      expect(replaced).toBe(true);
    } finally {
      spy.mockRestore();
      if (replaced) {
        fs.unlinkSync(storePath);
        fs.renameSync(detached, storePath);
      }
    }
    expect(fixture.snapshot()).toEqual(before);
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeDefined();
  }));
