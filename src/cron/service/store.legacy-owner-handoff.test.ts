import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareLegacyCronOwnerHandoffs } from "../../config/io.cron-owner-handoff.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  readRetainedLegacyDefaultCronOwnerForStore,
  retainLegacyDefaultCronOwnerHandoffForStore,
} from "../legacy-default-agent-owner-handoff.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { loadCronRows } from "../store/row-codec.js";
import type { CronJob } from "../types.js";
import {
  beginLegacyDefaultAgentOwnerHandoff,
  rejectConfigAdoption,
  reloadForConfigAdoption,
  start,
  stop,
} from "./ops-lifecycle.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-legacy-owner-handoff",
});
const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function createOwnerlessJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
  };
}

async function writeJobs(storePath: string, jobs: CronJob[]) {
  await saveCronStore(storePath, { version: 1, jobs });
}

function createState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => NOW,
    enqueueSystemEvent: () => false,
    requestHeartbeat: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const }),
  });
}

function incomingRoster(storePath: string): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    cron: { store: storePath } as never,
  };
}

describe("cron legacy owner handoff persistence", () => {
  it("schedules a row discovered by the migration leader without another restart", async () => {
    const { storePath } = await makeStorePath();
    const original = createOwnerlessJob("original");
    const discovered = createOwnerlessJob("discovered-during-handoff");
    await writeJobs(storePath, [original]);
    const state = createState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeJobs(storePath, [original, discovered]);

    const handoff = await beginLegacyDefaultAgentOwnerHandoff(state, "ops");
    try {
      const scheduled = state.store?.jobs.find((job) => job.id === discovered.id);
      expect(scheduled?.agentId).toBe("ops");
      expect(scheduled?.state.nextRunAtMs).toEqual(expect.any(Number));
      expect((await loadCronStore(storePath)).jobs.find((job) => job.id === discovered.id)).toEqual(
        expect.objectContaining({
          agentId: "ops",
          state: expect.objectContaining({ nextRunAtMs: expect.any(Number) }),
        }),
      );
    } finally {
      handoff.release();
      stop(state);
    }
  });

  it("reschedules an existing row whose schedule changed during the handoff", async () => {
    const { storePath } = await makeStorePath();
    const original = {
      ...createOwnerlessJob("rescheduled-during-handoff"),
      state: { nextRunAtMs: NOW + 60_000 },
    };
    await writeJobs(storePath, [original]);
    const state = createState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await writeJobs(storePath, [
      {
        ...original,
        schedule: { kind: "cron", expr: "30 7 * * *", tz: "UTC" },
        state: {},
      },
    ]);

    const handoff = await beginLegacyDefaultAgentOwnerHandoff(state, "ops");
    try {
      expect(state.store?.jobs[0]?.state.nextRunAtMs).toEqual(expect.any(Number));
      expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toEqual(
        expect.any(Number),
      );
    } finally {
      handoff.release();
      stop(state);
    }
  });

  it("preserves unparseable rows byte-for-byte during owner migration", async () => {
    const { storePath } = await makeStorePath();
    const valid = createOwnerlessJob("valid-ownerless");
    const forwardVersion = createOwnerlessJob("forward-version");
    await writeJobs(storePath, [valid, forwardVersion]);
    const database = openOpenClawStateDatabase().db;
    const storeKey = cronStoreKey(path.resolve(storePath));
    database
      .prepare("UPDATE cron_jobs SET schedule_kind = ? WHERE store_key = ? AND job_id = ?")
      .run("future-schedule-v2", storeKey, forwardVersion.id);
    const before = loadCronRows(database, storeKey).find((row) => row.job_id === forwardVersion.id);

    const state = createState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    const handoff = await beginLegacyDefaultAgentOwnerHandoff(state, "ops");
    handoff.release();
    stop(state);

    const after = loadCronRows(database, storeKey).find((row) => row.job_id === forwardVersion.id);
    expect(after).toEqual(before);
    expect((await loadCronStore(storePath)).jobs).toEqual([
      expect.objectContaining({ id: valid.id, agentId: "ops" }),
    ]);
  });

  it("migrates rows written by an old gateway after a separate config-write commit", async () => {
    const { storePath } = await makeStorePath();
    const originalOwnerless = createOwnerlessJob("original-ownerless");
    await writeJobs(storePath, [originalOwnerless]);

    const handoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "ops",
      targets: [{ config: {}, storePath }],
    });
    handoff.release();
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("ops");

    // Simulate pre-upgrade code replacing the migrated snapshot after the CLI
    // commit. It knows neither store epochs nor the durable handoff receipt.
    await writeJobs(storePath, [originalOwnerless, createOwnerlessJob("late-ownerless")]);

    const state = createState(storePath);
    state.deps.isAgentAvailable = (agentId) => agentId === "ops";
    await start(state);
    stop(state);

    expect((await loadCronStore(storePath)).jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "original-ownerless", agentId: "ops" }),
        expect.objectContaining({ id: "late-ownerless", agentId: "ops" }),
      ]),
    );
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("ops");

    // The old process still cannot be fenced after the first new-code startup.
    await writeJobs(storePath, [createOwnerlessJob("later-ownerless")]);
    const restarted = createState(storePath);
    restarted.deps.isAgentAvailable = (agentId) => agentId === "ops";
    await start(restarted);
    stop(restarted);
    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      id: "later-ownerless",
      agentId: "ops",
    });
  });

  it("keeps the receipt pending when the former owner has left the startup roster", async () => {
    const { storePath } = await makeStorePath();
    await writeJobs(storePath, [createOwnerlessJob("departed-owner")]);
    const handoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "ops",
      targets: [{ config: {}, storePath }],
    });
    handoff.release();

    await writeJobs(storePath, [createOwnerlessJob("late-departed-owner")]);
    const state = createState(storePath);
    state.deps.isAgentAvailable = () => false;
    await start(state);
    stop(state);

    expect((await loadCronStore(storePath)).jobs[0]?.agentId).toBeUndefined();
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("ops");
  });

  it("prefers the store receipt over conflicting process legacy metadata", async () => {
    const { storePath } = await makeStorePath();
    await writeJobs(storePath, [createOwnerlessJob("before-conflict")]);
    const handoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "research",
      targets: [{ config: {}, storePath }],
    });
    handoff.release();
    await writeJobs(storePath, [createOwnerlessJob("late-conflict")]);

    const state = createState(storePath);
    state.deps.legacyDefaultAgentId = "ops";
    state.deps.isAgentAvailable = () => true;
    await start(state);
    stop(state);

    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      id: "late-conflict",
      agentId: "research",
    });
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("research");
  });

  it("consumes a pending receipt when config adoption restores its owner", async () => {
    const { storePath } = await makeStorePath();
    await writeJobs(storePath, [createOwnerlessJob("before-restore")]);
    const handoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "ops",
      targets: [{ config: {}, storePath }],
    });
    handoff.release();
    await writeJobs(storePath, [createOwnerlessJob("late-before-restore")]);

    const state = createState(storePath);
    await reloadForConfigAdoption(state, incomingRoster(storePath));

    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      id: "late-before-restore",
      agentId: "ops",
    });
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("ops");
  });

  it("retains the runtime owner for late rows after receiptless adoption", async () => {
    const { storePath } = await makeStorePath();
    await writeJobs(storePath, [createOwnerlessJob("before-receiptless-adoption")]);
    const state = createState(storePath);
    state.deps.legacyDefaultAgentId = "ops";

    await reloadForConfigAdoption(state, incomingRoster(storePath));
    expect(readRetainedLegacyDefaultCronOwnerForStore(storePath)).toBe("ops");

    await writeJobs(storePath, [createOwnerlessJob("late-after-adoption")]);
    const restarted = createState(storePath);
    restarted.deps.isAgentAvailable = (agentId) => agentId === "ops";
    await start(restarted);
    stop(restarted);

    expect((await loadCronStore(storePath)).jobs[0]).toMatchObject({
      id: "late-after-adoption",
      agentId: "ops",
    });
  });

  it("migrates the incoming store before adopting a roster and store change", async () => {
    const { storePath: currentStorePath } = await makeStorePath();
    const { storePath: incomingStorePath } = await makeStorePath();
    await writeJobs(currentStorePath, [createOwnerlessJob("current-ownerless")]);
    await writeJobs(incomingStorePath, [createOwnerlessJob("incoming-ownerless")]);
    const state = createState(currentStorePath);
    state.deps.legacyDefaultAgentId = "ops";

    await reloadForConfigAdoption(state, incomingRoster(incomingStorePath));

    expect((await loadCronStore(currentStorePath)).jobs[0]).toMatchObject({
      id: "current-ownerless",
      agentId: "ops",
    });
    expect((await loadCronStore(incomingStorePath)).jobs[0]).toMatchObject({
      id: "incoming-ownerless",
      agentId: "ops",
    });
  });

  it("materializes destination legacy JSON owners during store-changing adoption", async () => {
    const { storePath: currentStorePath } = await makeStorePath();
    const { storePath: incomingStorePath } = await makeStorePath();
    await writeJobs(currentStorePath, [createOwnerlessJob("current-sqlite")]);
    await fs.mkdir(path.dirname(incomingStorePath), { recursive: true });
    await fs.writeFile(
      incomingStorePath,
      `${JSON.stringify({ version: 1, jobs: [createOwnerlessJob("incoming-json")] })}\n`,
      "utf8",
    );
    const state = createState(currentStorePath);
    state.deps.legacyDefaultAgentId = "ops";

    await reloadForConfigAdoption(state, incomingRoster(incomingStorePath));

    expect((await loadCronStore(incomingStorePath)).jobs[0]).toMatchObject({
      id: "incoming-json",
      agentId: "ops",
    });
  });

  it("restores destination rows and receipts when store-changing adoption is rejected", async () => {
    const { storePath: currentStorePath } = await makeStorePath();
    const { storePath: incomingStorePath } = await makeStorePath();
    await writeJobs(currentStorePath, [createOwnerlessJob("current-before-rejection")]);
    await writeJobs(incomingStorePath, [createOwnerlessJob("incoming-before-rejection")]);
    const state = createState(currentStorePath);
    state.deps.legacyDefaultAgentId = "ops";
    const db = openOpenClawStateDatabase().db;
    const incomingStoreKey = cronStoreKey(path.resolve(incomingStorePath));
    const rowsBefore = loadCronRows(db, incomingStoreKey);

    await reloadForConfigAdoption(state, incomingRoster(incomingStorePath));
    expect((await loadCronStore(incomingStorePath)).jobs[0]?.agentId).toBe("ops");
    expect(readRetainedLegacyDefaultCronOwnerForStore(incomingStorePath)).toBe("ops");

    await rejectConfigAdoption(state);

    expect(loadCronRows(db, incomingStoreKey)).toEqual(rowsBefore);
    expect(readRetainedLegacyDefaultCronOwnerForStore(incomingStorePath)).toBeUndefined();
  });

  it("keeps source and destination receipt owners distinct during store adoption", async () => {
    const { storePath: currentStorePath } = await makeStorePath();
    const { storePath: incomingStorePath } = await makeStorePath();
    await writeJobs(currentStorePath, [createOwnerlessJob("current-before-handoff")]);
    await writeJobs(incomingStorePath, [createOwnerlessJob("incoming-before-handoff")]);
    const currentHandoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "ops",
      targets: [{ config: {}, storePath: currentStorePath }],
    });
    currentHandoff.release();
    const incomingHandoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "research",
      targets: [{ config: {}, storePath: incomingStorePath }],
    });
    incomingHandoff.release();
    await writeJobs(currentStorePath, [createOwnerlessJob("current-late")]);
    await writeJobs(incomingStorePath, [createOwnerlessJob("incoming-late")]);

    await reloadForConfigAdoption(createState(currentStorePath), incomingRoster(incomingStorePath));

    expect((await loadCronStore(currentStorePath)).jobs[0]).toMatchObject({
      id: "current-late",
      agentId: "ops",
    });
    expect((await loadCronStore(incomingStorePath)).jobs[0]).toMatchObject({
      id: "incoming-late",
      agentId: "research",
    });
    expect(readRetainedLegacyDefaultCronOwnerForStore(currentStorePath)).toBe("ops");
    expect(readRetainedLegacyDefaultCronOwnerForStore(incomingStorePath)).toBe("research");
  });

  it("honors a destination receipt without changing receiptless destination ownership", async () => {
    const { storePath: sourceStorePath } = await makeStorePath();
    const { storePath: retainedDestinationPath } = await makeStorePath();
    const { storePath: receiptlessDestinationPath } = await makeStorePath();
    await writeJobs(sourceStorePath, [createOwnerlessJob("source-ownerless")]);
    await writeJobs(retainedDestinationPath, [createOwnerlessJob("retained-ownerless")]);
    await writeJobs(receiptlessDestinationPath, [createOwnerlessJob("receiptless-ownerless")]);
    retainLegacyDefaultCronOwnerHandoffForStore(retainedDestinationPath, "research", process.env);

    const handoff = await prepareLegacyCronOwnerHandoffs({
      env: process.env,
      legacyDefaultAgentId: "ops",
      targets: [sourceStorePath, retainedDestinationPath, receiptlessDestinationPath].map(
        (storePath) => ({ config: {}, storePath }),
      ),
    });
    handoff.release();

    expect((await loadCronStore(sourceStorePath)).jobs[0]?.agentId).toBe("ops");
    expect((await loadCronStore(retainedDestinationPath)).jobs[0]?.agentId).toBe("research");
    expect((await loadCronStore(receiptlessDestinationPath)).jobs[0]?.agentId).toBe("ops");
    expect(readRetainedLegacyDefaultCronOwnerForStore(retainedDestinationPath)).toBe("research");
    expect(readRetainedLegacyDefaultCronOwnerForStore(receiptlessDestinationPath)).toBe("ops");
  });
});
