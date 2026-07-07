/**
 * Real behavior proof: recovery jitter in recoverPendingDeliveries.
 *
 * Exercises the actual recoverPendingDeliveries with an ephemeral state
 * directory so the queue is empty (zero pending entries).  Verifies the
 * recovery path compiles, runs, and produces a valid zero-entry summary —
 * confirming the jitter insertion did not break control flow.
 *
 * Also exercises the exported computeBackoffMs and isEntryEligibleForRecoveryRetry
 * helpers to prove the backoff gating that the jitter complements is intact.
 *
 * Usage: node --import tsx test/_proof_delivery_queue_jitter.mts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function proof() {
  // ── Part 1: recovery with empty queue ──
  const { recoverPendingDeliveries } =
    await import("../src/infra/outbound/delivery-queue-recovery.js");

  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-proof-jitter-"));
  const logLines: string[] = [];
  const log = {
    info: (msg: string) => logLines.push(`INFO ${msg}`),
    warn: (msg: string) => logLines.push(`WARN ${msg}`),
    error: (msg: string) => logLines.push(`ERROR ${msg}`),
  };
  const deliver = async (_params: unknown) => {
    throw new Error("deliver should not be called on empty queue");
  };

  let summary;
  try {
    summary = await recoverPendingDeliveries({
      deliver: deliver as Parameters<
        typeof recoverPendingDeliveries
      >[0]["deliver"],
      log,
      cfg: { session: { store: stateDir } } as Parameters<
        typeof recoverPendingDeliveries
      >[0]["cfg"],
      stateDir,
      maxRecoveryMs: 5000,
    });
  } finally {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  check(
    "empty queue: 0 recovered",
    summary.recovered === 0,
    `got=${summary.recovered}`,
  );
  check("empty queue: 0 failed", summary.failed === 0, `got=${summary.failed}`);
  check(
    "empty queue: 0 skipped",
    summary.skippedMaxRetries === 0,
    `got=${summary.skippedMaxRetries}`,
  );
  check(
    "empty queue: 0 deferred",
    summary.deferredBackoff === 0,
    `got=${summary.deferredBackoff}`,
  );

  // ── Part 2: backoff helpers ──
  const { computeBackoffMs, isEntryEligibleForRecoveryRetry } =
    await import("../src/infra/outbound/delivery-queue-recovery.js");

  // computeBackoffMs
  check("backoff: retryCount=0 → 0", computeBackoffMs(0) === 0);
  check("backoff: retryCount=1 → >0", computeBackoffMs(1) > 0);

  // isEntryEligibleForRecoveryRetry — first attempt after crash (no lastAttemptAt)
  const now = Date.now();
  const firstReplayEntry = {
    id: "proof-1",
    retryCount: 0,
    enqueuedAt: now - 60000,
    lastAttemptAt: undefined,
  } as Parameters<typeof isEntryEligibleForRecoveryRetry>[0];
  check(
    "eligibility: first crash replay is eligible",
    isEntryEligibleForRecoveryRetry(firstReplayEntry, now).eligible === true,
  );

  // isEntryEligibleForRecoveryRetry — still in backoff
  const backoffMs = computeBackoffMs(1);
  const inBackoffEntry = {
    id: "proof-2",
    retryCount: 1,
    enqueuedAt: now - 60000,
    lastAttemptAt: now - 100, // just attempted 100ms ago
  } as Parameters<typeof isEntryEligibleForRecoveryRetry>[0];
  const eligibility = isEntryEligibleForRecoveryRetry(inBackoffEntry, now);
  if (backoffMs > 100) {
    check(
      "eligibility: in backoff → not eligible",
      eligibility.eligible === false,
      `remaining=${(eligibility as { remainingBackoffMs: number }).remainingBackoffMs}ms`,
    );
  } else {
    // If backoff is very short (< 100ms), it might be eligible already
    console.log(
      `  (skip: backoff too short for test, computeBackoffMs(1)=${backoffMs}ms)`,
    );
  }
}

async function main() {
  console.log(`node --import tsx test/_proof_delivery_queue_jitter.mts\n`);
  await proof();
  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
