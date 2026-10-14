import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { maybeAutoDisableCronJobAfterRunFailure } from "../../../cron/service/auto-disable.js";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import type { CronJob } from "../../../cron/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { applyLegacyCronStoreRepair, loadLegacyCronRepairState } from "./legacy-repair.js";

/**
 * Doctor's legacy repair writes definitions with `preserveRuntimeState`, so the
 * upsert's conflict update excludes `state_json` and an existing row keeps the
 * runtime state the scheduler owns. The restart-interruption normalization is
 * itself runtime state, so these cases drive the real repair-then-reload
 * boundary rather than `normalizeStoredCronJobs` in isolation: the in-memory
 * normalization is already covered by
 * `store-migration.restart-interruption.test.ts` and passed while the write was
 * being discarded.
 */

const LEGACY_INTERRUPTED_ERROR = "cron: job interrupted by gateway restart";
const CREATED_AT_MS = 1_700_000_000_000;

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await closeOpenClawAgentDatabasesAsync(tempRoot);
  }
  await closeOpenClawStateDatabaseAsync();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  vi.unstubAllEnvs();
});

function legacyJob(state: Record<string, unknown>): CronJob {
  return {
    id: "upgraded",
    name: "upgraded",
    enabled: true,
    createdAtMs: CREATED_AT_MS,
    updatedAtMs: CREATED_AT_MS,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    state,
  } as unknown as CronJob;
}

/** Seeds one pre-existing row, which is the shape whose conflict update drops state. */
async function seedLegacyStore(label: string, state: Record<string, unknown>): Promise<string> {
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`)));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await saveCronStore(storePath, { version: 1, jobs: [legacyJob(state)] });
  return storePath;
}

async function repairStore(storePath: string) {
  const cfg = { cron: { store: storePath } } as OpenClawConfig;
  const state = expectDefined(
    await loadLegacyCronRepairState({ cfg, storePath }),
    `repair state for ${storePath}`,
  );
  return await applyLegacyCronStoreRepair({ cfg, state });
}

async function reloadState(storePath: string): Promise<Record<string, unknown>> {
  const reloaded = expectDefined((await loadCronStore(storePath)).jobs[0], "reloaded cron job");
  return (reloaded.state ?? {}) as Record<string, unknown>;
}

/** Asks the production policy owner, not a restatement of its threshold. */
function askAutoDisable(storePath: string, state: Record<string, unknown>): Promise<boolean> {
  return loadCronStore(storePath).then((store) => {
    const job = expectDefined(store.jobs[0], "reloaded cron job");
    return maybeAutoDisableCronJobAfterRunFailure({
      job: { ...job, state: { ...job.state, ...state } } as CronJob,
      atMs: CREATED_AT_MS + 60_000,
      deferredNotifications: [],
    });
  });
}

it("persists the repaired interruption through Doctor's existing-row write", async () => {
  // v2026.9.9 shape: genuine failures plus one restart, no offset column yet.
  const storePath = await seedLegacyStore("cron-restart-repair-persist", {
    consecutiveErrors: 9,
    lastRunStatus: "error",
    lastError: LEGACY_INTERRUPTED_ERROR,
  });

  const repaired = await repairStore(storePath);

  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).toContainEqual(expect.stringContaining("gateway-restart interruption"));
  expect(await reloadState(storePath)).toMatchObject({
    consecutiveErrors: 9,
    consecutiveRestartInterruptions: 1,
    lastRunInterruptionReason: "gateway-restart",
  });
});

it("keeps the tenth failure slot unspent for a reloaded upgraded row", async () => {
  const storePath = await seedLegacyStore("cron-restart-repair-budget", {
    consecutiveErrors: 9,
    lastRunStatus: "error",
    lastError: LEGACY_INTERRUPTED_ERROR,
  });

  await repairStore(storePath);

  await expect(askAutoDisable(storePath, { consecutiveErrors: 10 })).resolves.toBe(false);
  await expect(askAutoDisable(storePath, { consecutiveErrors: 11 })).resolves.toBe(true);
});

it("leaves runtime state a writer committed after the snapshot alone", async () => {
  const storePath = await seedLegacyStore("cron-restart-repair-concurrent", {
    consecutiveErrors: 9,
    lastRunStatus: "error",
    lastError: LEGACY_INTERRUPTED_ERROR,
  });
  const cfg = { cron: { store: storePath } } as OpenClawConfig;
  const state = expectDefined(
    await loadLegacyCronRepairState({ cfg, storePath }),
    `repair state for ${storePath}`,
  );
  // The scheduler reports a successful run while doctor waits. Doctor's snapshot
  // guard fingerprints definitions only, so this write is invisible to it and a
  // wholesale state rewrite would resurrect the cleared streak.
  const scheduled = { consecutiveErrors: 0, lastRunStatus: "ok" };
  openOpenClawStateDatabase()
    .db.prepare(`UPDATE cron_jobs SET state_json = ? WHERE store_key = ? AND job_id = ?`)
    .run(JSON.stringify(scheduled), cronStoreKey(storePath), "upgraded");

  const repaired = await applyLegacyCronStoreRepair({ cfg, state });

  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).not.toContainEqual(
    expect.stringContaining("gateway-restart interruption"),
  );
  expect(await reloadState(storePath)).toEqual(scheduled);
});

it("records the interruption once across repeated repairs", async () => {
  const storePath = await seedLegacyStore("cron-restart-repair-idempotent", {
    consecutiveErrors: 9,
    lastRunStatus: "error",
    lastError: LEGACY_INTERRUPTED_ERROR,
  });

  await repairStore(storePath);
  const second = await repairStore(storePath);

  expect(second.warnings).toEqual([]);
  expect(second.changes).not.toContainEqual(
    expect.stringContaining("gateway-restart interruption"),
  );
  expect(await reloadState(storePath)).toMatchObject({ consecutiveRestartInterruptions: 1 });
});
