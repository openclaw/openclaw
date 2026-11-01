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

async function waitForChildReady(child: ChildProcess): Promise<void> {
  for await (const args of on(child, "message", { close: ["exit"] })) {
    const message: unknown = args[0];
    if (message && typeof message === "object" && "kind" in message && message.kind === "ready") {
      return;
    }
  }
  throw new Error("writer child exited before ready");
}

function waitForChildExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
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
    expect(result.stdout).not.toContain("=missing");
    const firstReport = JSON.parse(fs.readFileSync(output, "utf8")) as ReliabilityReport;
    expect(firstReport).toMatchObject({ concurrentRestoresVerified: 2, restoresVerified: 5 });
    expect(firstReport.writer.rowsCommitted).toBeGreaterThan(0);
    expect(firstReport.transactionProof.heldRows).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstReport.maintenanceProof.postCompact.state.batches).toBeGreaterThan(0);
    expect(firstReport.maintenanceProof.postCompact.state.rows).toBeGreaterThan(0);
    // The subprocess verifies payloads, crash exits, recovery, and compaction
    // before returning; keep report-specific expectations here, not a replay.
    const { repositoryInterruption: repository } = firstReport.maintenanceProof;
    for (const [proof, published, visible] of [
      [repository.beforePending, false, 1],
      [repository.pending, true, 3],
      [repository.afterCommit, true, 5],
    ] as const) {
      expect(proof).toMatchObject({
        crashSnapshotVerifiedAfterCrash: published,
        crashSnapshotVisibleAfterCrash: published,
        visibleSnapshotsAfterCrash: visible,
      });
    }
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
