import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { loadLegacyCronQuarantineForMigration } from "../commands/doctor/cron/legacy-quarantine-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  loadLegacyCronStoreForMigration,
} from "../commands/doctor/cron/legacy-store-migration.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { createStorePathFixture, expectPathMissing, makeStore } from "./store.test-support.js";

const makeStorePath = createStorePathFixture();

function resolveLegacyCronQuarantinePath(storePath: string): string {
  return storePath.replace(/\.json$/, "-quarantine.json");
}

async function writeLegacyJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("cron store", () => {
  it("throws when doctor migration reads invalid legacy JSON", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await expect(loadLegacyCronStoreForMigration(store.storePath)).rejects.toThrow(
      /Failed to parse cron store/i,
    );
  });

  it("accepts JSON5 syntax when loading a legacy cron store for doctor migration", async () => {
    const store = await makeStorePath();
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      `{
        // hand-edited legacy store
        version: 1,
        jobs: [
          {
            id: 'job-1',
            name: 'Job 1',
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: 'every', everyMs: 60000 },
            sessionTarget: 'main',
            wakeMode: 'next-heartbeat',
            payload: { kind: 'systemEvent', text: 'tick-job-1' },
            state: {},
          },
        ],
      }`,
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    expect(loaded.version).toBe(1);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-1");
    expect(loaded.jobs[0]?.enabled).toBe(true);
  });

  it("loads legacy top-level array stores for doctor migration", async () => {
    const store = await makeStorePath();
    const first = makeStore("legacy-array-1", true).jobs[0];
    const second = makeStore("legacy-array-2", false).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, [first, "bad-row", null, second]);

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.version).toBe(1);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["legacy-array-1", "legacy-array-2"]);
    expect(loaded.jobs[0]?.state).toStrictEqual(first.state);
    expect(loaded.jobs[1]?.enabled).toBe(false);
  });

  it("does not load legacy top-level array stores from core", async () => {
    const store = await makeStorePath();
    const job = makeStore("legacy-array-core", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify([job], null, 2), "utf-8");

    const loaded = await loadCronStore(store.storePath);

    expect(loaded.jobs).toHaveLength(0);
  });

  it("lets doctor import legacy top-level array jobs into SQLite and archive the source", async () => {
    const store = await makeStorePath();
    const legacy = makeStore("legacy-array-preserved", true).jobs[0];
    legacy.state = { nextRunAtMs: legacy.createdAtMs + 60_000 };
    const added = makeStore("new-job", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, [legacy]);

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    loaded.jobs.push(added);
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    const roundTrip = await loadCronStore(store.storePath);
    expect(roundTrip.jobs.map((job) => job.id)).toEqual(["legacy-array-preserved", "new-job"]);
    expect(roundTrip.jobs[0]?.state.nextRunAtMs).toBe(legacy.createdAtMs + 60_000);
    await expectPathMissing(store.storePath);
    expect(await fs.stat(`${store.storePath}.migrated`)).toBeTruthy();
  });

  it("skips non-object legacy persisted jobs during doctor migration", async () => {
    const store = await makeStorePath();
    const valid = makeStore("job-valid", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, {
      version: 1,
      jobs: ["bad-row", 7, null, false, valid],
    });

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-valid");
    expect(loaded.jobs[0]?.state).toStrictEqual({});
  });

  it("loads malformed legacy stores for doctor without archiving first", async () => {
    const store = await makeStorePath();
    const valid = makeStore("job-valid-unarchived", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, {
      version: 1,
      jobs: [
        valid,
        {
          id: "bad-schedule-unarchived",
          name: "bad schedule",
          enabled: true,
          createdAtMs: valid.createdAtMs,
          updatedAtMs: valid.updatedAtMs,
          schedule: ["every", 60_000],
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });

    const loaded = await loadLegacyCronStoreForMigration(store.storePath);

    expect(loaded.store.jobs.map((job) => job.id)).toEqual([
      "job-valid-unarchived",
      "bad-schedule-unarchived",
    ]);
    expect(await fs.stat(store.storePath)).toBeTruthy();
    await expectPathMissing(`${store.storePath}.migrated`);
  });

  it("does not import legacy files from core reads", async () => {
    const store = await makeStorePath();
    const valid = makeStore("job-valid-core-unarchived", true).jobs[0];
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, { version: 1, jobs: ["bad-row", valid] });

    const loaded = await loadCronStore(store.storePath);

    expect(loaded.jobs.map((job) => job.id)).toEqual([]);
    expect(await fs.stat(store.storePath)).toBeTruthy();
    await expectPathMissing(`${store.storePath}.migrated`);
  });

  it("rejects unrecognized historical quarantine files without modifying them", async () => {
    const { storePath } = await makeStorePath();
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeLegacyJson(quarantinePath, {
      version: 2,
      jobs: [{ reason: "old-shape", raw: "keep-me" }],
    });

    await expect(loadLegacyCronQuarantineForMigration(storePath)).rejects.toThrow(
      /Unsupported cron quarantine file shape/,
    );

    const preserved = JSON.parse(await fs.readFile(quarantinePath, "utf-8")) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(preserved.jobs[0]?.raw).toBe("keep-me");
  });

  it("loads split cron state for legacy jobId rows during doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeLegacyJson(storePath, {
      version: 1,
      jobs: [
        {
          jobId: "legacy-sync-job",
          name: "legacy sync job",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "tick" },
        },
      ],
    });
    await writeLegacyJson(statePath, {
      version: 1,
      jobs: {
        "legacy-sync-job": {
          updatedAtMs: 123,
          state: { runningAtMs: 456 },
        },
      },
    });

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.state).toEqual({ runningAtMs: 456 });
    expect(loaded.jobs[0]?.updatedAtMs).toBe(123);
  });

  it("compares split state identity for flat legacy cron rows during doctor migration", async () => {
    const { storePath } = await makeStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeLegacyJson(storePath, {
      version: 1,
      jobs: [
        {
          id: "legacy-flat-cron",
          name: "legacy flat cron",
          enabled: true,
          kind: "cron",
          cron: "*/10 * * * *",
          tz: "UTC",
        },
      ],
    });
    await writeLegacyJson(statePath, {
      version: 1,
      jobs: {
        "legacy-flat-cron": {
          updatedAtMs: 1,
          scheduleIdentity: JSON.stringify({
            version: 1,
            enabled: true,
            schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
          }),
          state: { nextRunAtMs: 123 },
        },
      },
    });

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.state.nextRunAtMs).toBeUndefined();
  });

  it("drops stale split runtime nextRunAtMs when doctor imports edited legacy config", async () => {
    const { storePath } = await makeStorePath();
    const payload = makeStore("job-restart-drift", true);
    const staleNextRunAtMs = payload.jobs[0].createdAtMs + 3_600_000;
    payload.jobs[0].schedule = {
      kind: "cron",
      expr: "30 6 * * 0,6",
      tz: "UTC",
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeLegacyJson(storePath, payload);
    await fs.writeFile(
      storePath.replace(/\.json$/, "-state.json"),
      JSON.stringify({
        version: 1,
        jobs: {
          [payload.jobs[0].id]: {
            updatedAtMs: payload.jobs[0].updatedAtMs,
            scheduleIdentity: JSON.stringify({
              version: 1,
              enabled: true,
              schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
            }),
            state: { nextRunAtMs: staleNextRunAtMs },
          },
        },
      }),
      "utf-8",
    );

    const loaded = (await loadLegacyCronStoreForMigration(storePath)).store;

    expect(loaded.jobs[0]?.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBeUndefined();
  });

  it("does not import stale split runtime nextRunAtMs from legacy files", async () => {
    const { storePath } = await makeStorePath();
    const payload = makeStore("job-core-restart-drift", true);
    const staleNextRunAtMs =
      expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").createdAtMs + 3_600_000;
    expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").schedule = {
      kind: "every",
      everyMs: 60_000,
      anchorMs: 2,
    };
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.writeFile(
      storePath.replace(/\.json$/, "-state.json"),
      JSON.stringify({
        version: 1,
        jobs: {
          [expectDefined(payload.jobs[0], "payload.jobs[0] test invariant").id]: {
            updatedAtMs: expectDefined(payload.jobs[0], "payload.jobs[0] test invariant")
              .updatedAtMs,
            scheduleIdentity: JSON.stringify({
              version: 1,
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
            }),
            state: { nextRunAtMs: staleNextRunAtMs },
          },
        },
      }),
      "utf-8",
    );

    const loaded = await loadCronStore(storePath);

    expect(loaded.jobs).toEqual([]);
  });

  it("lets doctor migrate legacy inline state into SQLite", async () => {
    const store = await makeStorePath();
    const legacy = makeStore("job-1", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, legacy);

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    const roundTrip = await loadCronStore(store.storePath);
    expect(roundTrip.jobs[0]?.updatedAtMs).toBe(legacy.jobs[0].updatedAtMs);
    expect(roundTrip.jobs[0]?.state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
    await expectPathMissing(store.storePath);
    expect(await fs.stat(`${store.storePath}.migrated`)).toBeTruthy();
  });

  it("ignores array-shaped state sidecars when doctor migrates legacy inline state", async () => {
    const store = await makeStorePath();
    const statePath = store.storePath.replace(/\.json$/, "-state.json");
    // Numeric-looking IDs catch accidental array indexing in invalid sidecars.
    const legacy = makeStore("0", true);
    legacy.jobs[0].state = {
      lastRunAtMs: legacy.jobs[0].createdAtMs + 30_000,
      nextRunAtMs: legacy.jobs[0].createdAtMs + 60_000,
    };
    const staleSidecar = {
      ...legacy,
      jobs: [
        {
          ...legacy.jobs[0],
          updatedAtMs: legacy.jobs[0].updatedAtMs + 10_000,
          state: {
            nextRunAtMs: legacy.jobs[0].createdAtMs + 120_000,
          },
        },
      ],
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, legacy);
    await writeLegacyJson(statePath, staleSidecar);

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;
    await saveCronStore(store.storePath, loaded);
    await archiveLegacyCronStoreForMigration(store.storePath);

    expect(loaded.jobs[0]?.updatedAtMs).toBe(legacy.jobs[0].updatedAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(legacy.jobs[0].createdAtMs + 60_000);
    await expectPathMissing(statePath);
    expect(await fs.stat(`${statePath}.migrated`)).toBeTruthy();
  });

  it("treats a corrupt state sidecar as absent during doctor migration", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = {
      nextRunAtMs: payload.jobs[0].createdAtMs + 60_000,
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, {
      version: 1,
      jobs: payload.jobs.map((job) => ({ ...job, state: {}, updatedAtMs: undefined })),
    });
    await fs.writeFile(statePath, "{ not json", "utf-8");

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(payload.jobs[0].createdAtMs);
    expect(loaded.jobs[0]?.state).toStrictEqual({});
  });

  it("propagates unreadable state sidecar errors during doctor migration", async () => {
    const store = await makeStorePath();
    const payload = makeStore("job-1", true);
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, payload);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const origReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === statePath) {
        const err = new Error("permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origReadFile(filePath, options as never) as never;
    });

    try {
      await expect(loadLegacyCronStoreForMigration(store.storePath)).rejects.toThrow(
        /Failed to read cron state/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("sanitizes invalid updatedAtMs values from the state sidecar during doctor migration", async () => {
    const store = await makeStorePath();
    const job = makeStore("job-1", true).jobs[0];
    const config = {
      version: 1,
      jobs: [{ ...job, state: {}, updatedAtMs: undefined }],
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, config);
    await writeLegacyJson(statePath, {
      version: 1,
      jobs: {
        [job.id]: {
          updatedAtMs: "invalid",
          state: { nextRunAtMs: job.createdAtMs + 60_000 },
        },
      },
    });

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(job.createdAtMs);
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
  });

  it("drops non-object runtime state from split cron sidecars during doctor migration", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-array-state", true).jobs[0];
    const second = makeStore("job-scalar-entry", true).jobs[0];
    const config = {
      version: 1,
      jobs: [
        { ...first, state: {}, updatedAtMs: undefined },
        { ...second, state: {}, updatedAtMs: undefined },
      ],
    };
    const statePath = store.storePath.replace(/\.json$/, "-state.json");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await writeLegacyJson(store.storePath, config);
    await writeLegacyJson(statePath, {
      version: 1,
      jobs: {
        [first.id]: {
          updatedAtMs: first.createdAtMs + 60_000,
          state: ["not", "state"],
        },
        [second.id]: "not-an-entry",
      },
    });

    const loaded = (await loadLegacyCronStoreForMigration(store.storePath)).store;

    expect(loaded.jobs[0]?.updatedAtMs).toBe(first.createdAtMs + 60_000);
    expect(loaded.jobs[0]?.state).toStrictEqual({});
    expect(loaded.jobs[1]?.updatedAtMs).toBe(second.createdAtMs);
    expect(loaded.jobs[1]?.state).toStrictEqual({});
  });
});
