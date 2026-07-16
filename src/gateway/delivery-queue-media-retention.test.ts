// Pins the retention contract between the gateway media sweep and the delivery
// queue: the sweep retains every artifact a *pending* row still names, and a row
// waiting out retry backoff is still pending. Exercises the real maintenance
// closure (which builds its retain set from loadPendingDeliveries) rather than
// handing a synthetic Set to the low-level reclaimer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

// Only the liveness probe is stubbed: a dead owner is otherwise unreachable from
// an in-process test. Siblings import the rest of this module and must keep the
// real implementations.
const pidAlive = vi.hoisted(() => ({
  isPidDefinitelyDead: vi.fn<(pid: number) => boolean>(),
}));

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  ...pidAlive,
}));

const NONCE = "0".repeat(32);
const OTHER_NONCE = "1".repeat(32);
// Producer of the queued artifact, and an unreferenced generation used as the
// sweep's completion barrier. Neither is this process.
const PRODUCER_PID = 987_001;
const ORPHAN_PID = 987_002;
const QUEUE_NAME = "outbound";

let stateDir: string;
let spoolRoot: string;
let previousStateDir: string | undefined;

/** Materializes a generation directory holding one artifact, as a producer would. */
async function seedGeneration(params: { pid: number; nonce: string; artifact: string }) {
  const generationPath = path.join(spoolRoot, `${params.pid}-900-${params.nonce}`);
  await fs.mkdir(generationPath, { recursive: true });
  const artifactPath = path.join(generationPath, params.artifact);
  await fs.writeFile(artifactPath, "audio-bytes");
  return { generationPath, artifactPath };
}

const exists = (target: string) =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Runs the gateway's own startup media sweep and resolves once it has completed a
 * full pass, proven by the unreferenced orphan it is expected to remove.
 */
async function runGatewayMediaSweep(orphanArtifactPath: string): Promise<void> {
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  // No runDeliveryQueueMediaGc override: this must be the production closure.
  const timers = startGatewayMaintenanceTimers({
    ...createGatewayMaintenanceStateForTest(),
    runWorktreeGc: vi.fn(async () => undefined),
  });
  try {
    await waitFor(async () => !(await exists(orphanArtifactPath)), "the media sweep to finish");
  } finally {
    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    clearInterval(timers.worktreeCleanup);
    clearInterval(timers.deliveryQueueMediaCleanup);
    if (timers.mediaCleanup) {
      clearInterval(timers.mediaCleanup);
    }
    timers.skillCuratorCleanup();
  }
}

beforeEach(async () => {
  // Prod resolvers realpath their roots; macOS /var -> /private/var would break
  // raw mkdtemp comparisons.
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "queue-media-retention-")));
  spoolRoot = path.join(stateDir, "delivery-queue-media");
  await fs.mkdir(spoolRoot, { recursive: true });
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  // The production sweep resolves the state dir itself; it takes no stateDir.
  process.env.OPENCLAW_STATE_DIR = stateDir;
  pidAlive.isPidDefinitelyDead.mockReset();
  pidAlive.isPidDefinitelyDead.mockImplementation(
    (pid) => pid === PRODUCER_PID || pid === ORPHAN_PID,
  );
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("delivery queue media retention", () => {
  it("keeps a dead producer's artifact while its row waits out retry backoff", async () => {
    const { enqueueDelivery, failDelivery, loadPendingDeliveries } =
      await import("../infra/outbound/delivery-queue.js");
    const { recoverPendingDeliveries } =
      await import("../infra/outbound/delivery-queue-recovery.js");
    const { deleteDeliveryQueueEntry } = await import("../infra/delivery-queue-sqlite.js");

    const { artifactPath } = await seedGeneration({
      pid: PRODUCER_PID,
      nonce: NONCE,
      artifact: "voice.ogg",
    });
    // Same dead-owner state, but no row will ever name it. Its removal proves the
    // sweep ran and was capable of deleting from a dead generation.
    const orphan = await seedGeneration({
      pid: ORPHAN_PID,
      nonce: OTHER_NONCE,
      artifact: "orphan.ogg",
    });

    const id = await enqueueDelivery(
      {
        channel: "matrix",
        to: "!room:example",
        queuePolicy: "best_effort",
        payloads: [{ text: "voice note", mediaUrl: artifactPath, audioAsVoice: true }],
      },
      stateDir,
    );
    // retryCount 3 (< MAX_RETRIES) puts the next attempt 10 minutes out, so the
    // row is pending but provably not yet due.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await failDelivery(id, "transient send failure", stateDir);
    }

    await runGatewayMediaSweep(orphan.artifactPath);

    // The producer is gone and the retry is not due, but the row still has to
    // replay this artifact.
    expect(await exists(artifactPath)).toBe(true);

    // The retain set must come from the full pending inventory, not a due-work
    // subset: this row is what keeps the artifact alive.
    const pending = await loadPendingDeliveries(stateDir);
    expect(pending.map((entry) => entry.id)).toEqual([id]);

    // Backoff is applied here, after the inventory is loaded — not by the query.
    const deliver = vi.fn();
    const summary = await recoverPendingDeliveries({
      deliver,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      cfg: {} as OpenClawConfig,
      stateDir,
    });
    expect(summary.deferredBackoff).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(await exists(artifactPath)).toBe(true);

    // Drop the row without releasing its media, the window ackDelivery documents
    // (delete commits, process dies before the unlink). Only the row changes; the
    // generation is as dead as it was above.
    deleteDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);

    const secondOrphan = await seedGeneration({
      pid: ORPHAN_PID,
      nonce: OTHER_NONCE,
      artifact: "orphan.ogg",
    });
    await runGatewayMediaSweep(secondOrphan.artifactPath);

    // Nothing names it now, so the same sweep reclaims it.
    expect(await exists(artifactPath)).toBe(false);
  });
});
