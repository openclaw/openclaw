import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSqliteReliabilityCli } from "../../scripts/lib/sqlite-reliability-cli.js";
import {
  formatReliabilityStderr,
  STRESS_TABLE_SQL,
  type ReliabilityReport,
} from "../../scripts/lib/sqlite-reliability-contract.js";
import { monitorSqliteWalDuring } from "../../scripts/lib/sqlite-reliability-wal-monitor.js";
import {
  canonicalPathWithExistingParent,
  isPendingPathInRepository,
} from "../../scripts/lib/sqlite-reliability-worker-paths.js";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../src/state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeRoot = () => tempDirs.make("openclaw-sqlite-reliability-test-");
const nodeExecutable = resolveTestNodeExecPath();
const nodeArgs = resolveVitestNodeArgs();
// Windows repeats ACL checks and crash/restore copies throughout the full proof.
const RELIABILITY_PROOF_TIMEOUT_MS = process.platform === "win32" ? 480_000 : 240_000;
const RELIABILITY_SMOKE_TEST_TIMEOUT_MS = process.platform === "win32" ? 1_200_000 : 300_000;
const MIN_MULTICHUNK_RESTORE_BYTES = 2 * 1024 * 1024;
const COMPACTION_FIXTURE_ROWS = 12;
const COMPACTION_PAYLOAD_BYTES = 256 * 1024;
const VACUUM_PROOF_ROWS = 64;

function reliabilitySmokeTest(name: string, test: () => void): void {
  it(name, test, RELIABILITY_SMOKE_TEST_TIMEOUT_MS);
}

function runProof(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    nodeExecutable,
    [...nodeArgs, "--import", "tsx", "scripts/bench-sqlite-reliability.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: RELIABILITY_PROOF_TIMEOUT_MS,
    },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

function expectExited(exit: { code: number | null; signal: NodeJS.Signals | null }) {
  expect(exit.code !== null || exit.signal !== null).toBe(true);
}

function expectInterrupted(
  proof: { exit: Parameters<typeof expectExited>[0]; stagingEntries: number },
  expected: Record<string, unknown>,
) {
  expect(proof).toMatchObject({ recoveryVerified: true, ...expected });
  expect(proof.stagingEntries).toBeGreaterThan(0);
  expectExited(proof.exit);
}

function payload(rows: number) {
  return { bytes: rows * COMPACTION_PAYLOAD_BYTES, idSum: (rows * (rows + 1)) / 2, rows };
}

async function waitForChildReady(child: ChildProcess): Promise<void> {
  for await (const args of on(child, "message", { close: ["exit"] })) {
    const message: unknown = args[0];
    if (message && typeof message === "object" && "kind" in message && message.kind === "ready") {
      return;
    }
  }
  throw new Error("writer child exited before ready");
}

function waitForChildExit(child: ChildProcess): Promise<Parameters<typeof expectExited>[0]> {
  return once(child, "exit").then(([code, signal]) => ({ code, signal }));
}

describe("scripts/bench-sqlite-reliability", () => {
  it.each([
    ["whitespace-only stderr", " \n\t ", ""],
    [
      "multiline quoted stderr",
      ' first line\n"quoted"\\path ',
      ' stderr="first line\\n\\"quoted\\"\\\\path"',
    ],
  ])("formats %s", (_name, stderr, expected) => {
    expect(formatReliabilityStderr(stderr)).toBe(expected);
  });

  it("detects a transient WAL overrun before the file shrinks", async () => {
    const walPath = path.join(makeRoot(), "database.sqlite-wal");
    let stopRequests = 0;

    await expect(
      monitorSqliteWalDuring({
        maxWalBytes: 1024,
        onLimitExceeded: () => {
          stopRequests += 1;
        },
        operation: async () => {
          fs.writeFileSync(walPath, Buffer.alloc(2048));
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          fs.truncateSync(walPath, 0);
          return "complete";
        },
        pollIntervalMs: 5,
        walPath,
      }),
    ).rejects.toThrow("SQLite reliability WAL exceeded the 1024-byte profile limit: 2048 bytes");
    expect(stopRequests).toBe(1);
  });

  it("rejects malformed arguments before creating state", () => {
    const unknown = runProof(["--wat"]);
    expect(unknown).toMatchObject({ status: 2, stdout: "" });
    expect(unknown.stderr.trim()).toBe("error: Unknown argument: --wat");

    expect(() => parseSqliteReliabilityCli(["--profile", "smoke", "--profile", "large"])).toThrow(
      "--profile was provided more than once",
    );
    expect(() => parseSqliteReliabilityCli(["--profile", "huge"])).toThrow(
      '--profile must be one of smoke, default, large; got "huge"',
    );
    expect(parseSqliteReliabilityCli(["--help", "--profile", "huge"])).toEqual({
      help: true,
    });
  });

  reliabilitySmokeTest("proves snapshot reliability while safely reusing state", () => {
    const stateDir = makeRoot();
    const previousSyncedRepository = path.join(
      stateDir,
      "sqlite-reliability-runs/previous-run/synced-snapshots",
    );
    const previousArtifact = path.join(previousSyncedRepository, "previous-artifact");
    fs.mkdirSync(previousSyncedRepository, { recursive: true, mode: 0o700 });
    fs.writeFileSync(previousArtifact, "retained");

    const existingDatabase = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    try {
      existingDatabase.db.exec(STRESS_TABLE_SQL);
      existingDatabase.db
        .prepare(
          "INSERT INTO openclaw_reliability_entries (batch, ordinal, payload) VALUES (?, ?, ?)",
        )
        .run(999_999, 0, "stale-profile-row");
    } finally {
      closeOpenClawStateDatabaseForTest();
    }

    const output = path.join(stateDir, "report.json");
    const compilerPolicyProbe = path.join(stateDir, "compiler-policy-probe.mjs");
    fs.writeFileSync(
      compilerPolicyProbe,
      `import { isMainThread } from "node:worker_threads";
if (isMainThread && !process.execArgv.includes("--no-concurrent-sparkplug")) {
  throw new Error("SQLite proof subprocess discarded the selected Node compiler policy");
}
`,
    );
    const result = runProof(["--profile", "smoke", "--state-dir", stateDir, "--output", output], {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import=${pathToFileURL(compilerPolicyProbe).href}`,
      ]
        .filter(Boolean)
        .join(" "),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_TARGET=global");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_RESTORES_VERIFIED=5");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_CRASH_RECOVERY=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_PUBLICATION_INTERRUPTION=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_RESTORE_INTERRUPTION=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_REPOSITORY_INTERRUPTION=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_INDEX_REPAIR_INTERRUPTION=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_VACUUM_INTERRUPTION=verified");
    expect(result.stdout).toContain("SQLITE_RELIABILITY_POST_COMPACT_RESTORE=verified");
    expect(result.stdout).not.toContain("=missing");
    const firstReport = JSON.parse(fs.readFileSync(output, "utf8")) as ReliabilityReport;
    const {
      crashRecoveryProof: crash,
      publicationInterruptionProof: publication,
      indexRepairInterruptionProof: indexRepair,
      transactionProof: transaction,
      maintenanceProof: {
        repositoryInterruption: repository,
        restoreInterruption: restore,
        vacuumInterruption: vacuum,
        compaction,
        postCompact,
      },
    } = firstReport;
    expect(firstReport).toMatchObject({ concurrentRestoresVerified: 2, restoresVerified: 5 });
    expectExited(crash.exit);
    expect(crash.stateAfterRecovery).toEqual(crash.stateBeforeKill);
    expectInterrupted(publication.beforePublish, {
      retryPublished: true,
      sourceStatePreserved: true,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    });
    expectInterrupted(publication.afterPublish, {
      existingTargetPreserved: true,
      sourceStatePreserved: true,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    });
    for (const proof of [indexRepair.rollbackJournal, indexRepair.wal]) {
      expect(proof).toMatchObject({
        recoveryVerified: true,
        repairedIndexes: ["idx_openclaw_reliability_records_identity"],
      });
      expectExited(proof.exit);
    }
    expect(indexRepair.rollbackJournal.journalBytesObserved).toBeGreaterThan(0);
    expect(indexRepair.wal.walBytesObserved).toBeGreaterThan(0);
    expect(transaction.committedWalSentinel).toBe(true);
    expect(transaction.heldRows).toBeGreaterThan(0);
    expect(transaction.visibleAfterRestore).toBe(false);
    expect(firstReport.writer.rowsCommitted).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.bloatBytes).toBe(
      VACUUM_PROOF_ROWS * COMPACTION_PAYLOAD_BYTES,
    );
    expect(compaction.autoVacuum.after).toBe(2);
    expect(compaction.freelistPages.before).toBeGreaterThan(0);
    expect(compaction.freelistPages.after).toBe(0);
    expect(compaction.reclaimedBytes).toBeGreaterThan(0);
    expect(compaction.walBytes.after).toBe(0);
    expect(vacuum.recoveryVerified).toBe(true);
    expect(vacuum.autoVacuumBeforeKill).toBe(0);
    expect(vacuum.autoVacuumAfterRecovery).toBe(0);
    expectExited(vacuum.exit);
    expect(vacuum.journalBytesObserved > 0 || vacuum.walBytesObserved > 0).toBe(true);
    expect(vacuum.payloadAfterRecovery).toEqual(vacuum.payloadBeforeKill);
    expect(vacuum.payloadBeforeKill).toEqual(payload(VACUUM_PROOF_ROWS));
    expect(vacuum.stateAfterRecovery).toEqual(vacuum.stateBeforeKill);
    for (const [proof, published, visible] of [
      [repository.beforePending, false, 1],
      [repository.pending, true, 3],
      [repository.afterCommit, true, 5],
    ] as const) {
      expect(proof).toMatchObject({
        crashSnapshotVerifiedAfterCrash: published,
        crashSnapshotVisibleAfterCrash: published,
        incompleteEntries: published ? 0 : 1,
        repositoryVerified: true,
        retryCreated: true,
        sourcePayloadPreserved: true,
        sourceStatePreserved: true,
        visibleSnapshotsAfterCrash: visible,
      });
      expect(proof.stagingEntries).toBeGreaterThan(0);
      expectExited(proof.exit);
    }
    expect(repository.beforePending.state).toEqual(repository.pending.state);
    expect(repository.pending.state).toEqual(repository.afterCommit.state);
    expect(repository.beforePending.payload).toEqual(repository.pending.payload);
    expect(repository.pending.payload).toEqual(repository.afterCommit.payload);
    expect(repository.beforePending.payload).toEqual(payload(COMPACTION_FIXTURE_ROWS));
    expect(restore.snapshotBytes).toBeGreaterThan(MIN_MULTICHUNK_RESTORE_BYTES);
    expectInterrupted(restore.beforePublish, {
      existingTargetPreserved: false,
      repositoryVerified: true,
      retryRestored: true,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    });
    expect(restore.beforePublish.stateAfterRecovery).toEqual(postCompact.state);
    expect(restore.beforePublish.payloadAfterRecovery).toEqual(payload(COMPACTION_FIXTURE_ROWS));
    expectInterrupted(restore.afterPublish, {
      existingTargetPreserved: true,
      repositoryVerified: true,
      retryRestored: false,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    });
    expect(restore.afterPublish.stateAfterRecovery).toEqual(
      restore.beforePublish.stateAfterRecovery,
    );
    expect(restore.afterPublish.payloadAfterRecovery).toEqual(
      restore.beforePublish.payloadAfterRecovery,
    );
    expect(postCompact.restoreVerified).toBe(true);
    expect(postCompact.state.batches).toBeGreaterThan(0);
    expect(postCompact.state.rows).toBeGreaterThan(0);
    expect(postCompact.state.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstReport.walBytes.limit).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeGreaterThan(0);
    expect(firstReport.walBytes.peak).toBeLessThanOrEqual(firstReport.walBytes.limit);

    expect(firstReport.paths.syncedRepository).not.toBe(previousSyncedRepository);
    expect(fs.readFileSync(previousArtifact, "utf8")).toBe("retained");

    const database = openNodeSqliteDatabase(firstReport.paths.sourceDatabase, { readOnly: true });
    try {
      const staleRows = database
        .prepare("SELECT COUNT(*) AS rows FROM openclaw_reliability_entries WHERE batch = ?")
        .get(999_999) as { rows?: unknown };
      expect(Number(staleRows.rows)).toBe(0);
    } finally {
      database.close();
    }
  });

  it("matches crash barriers across filesystem path aliases", () => {
    const realRoot = makeRoot();
    const aliasRoot = path.join(makeRoot(), "alias");
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const repositoryPath = path.join(realRoot, "snapshots");
    const snapshotPath = path.join(repositoryPath, "snapshot");
    fs.mkdirSync(snapshotPath, { recursive: true });

    const canonicalRepositoryPath = canonicalPathWithExistingParent(
      path.join(aliasRoot, "snapshots"),
    );
    expect(canonicalRepositoryPath).toBe(path.join(fs.realpathSync.native(realRoot), "snapshots"));
    expect(
      isPendingPathInRepository(
        path.join(aliasRoot, "snapshots", "snapshot", ".pending"),
        canonicalRepositoryPath,
      ),
    ).toBe(true);

    const finalAlias = path.join(realRoot, "final-alias");
    fs.symlinkSync(snapshotPath, finalAlias, process.platform === "win32" ? "junction" : "dir");
    expect(canonicalPathWithExistingParent(finalAlias)).toBe(
      path.join(fs.realpathSync.native(realRoot), "final-alias"),
    );
  });

  it("stops the writer when its parent IPC channel disconnects", async ({ signal }) => {
    const databasePath = path.join(makeRoot(), "writer.sqlite");
    const writerUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.sqliteReliabilityWriter);
    const child = fork(
      fileURLToPath(writerUrl),
      [databasePath, "8", "64", "4", "256", String(64 * 1024 * 1024), "1"],
      {
        cwd: process.cwd(),
        execPath: nodeExecutable,
        execArgv: [...nodeArgs, ...resolveRuntimeWorkerThreadExecArgv(writerUrl, nodeExecutable)],
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const exitPromise = waitForChildExit(child);
    // Readiness and exit are both owned by this child; the test signal owns the deadline.
    void exitPromise.catch(() => {});
    try {
      await withinTest(waitForChildReady(child), signal);
      child.disconnect();
      await expect(withinTest(exitPromise, signal)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exitPromise;
    }
  });
});
