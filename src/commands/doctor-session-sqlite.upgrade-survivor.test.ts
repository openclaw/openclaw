import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { prepareUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import { defaultRuntime } from "../runtime.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
afterEach(async () => {
  await cleanupSessionStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("proves the survivor archive before automatic retirement and rejects unproven disposal", async () => {
  const store = createLegacyStore({ agentDirName: "ops" });
  fs.writeFileSync(store.storePath, "{}");
  for (const file of [store.transcriptPath, store.trajectoryPath, store.unreferencedJsonlPath]) {
    fs.unlinkSync(file);
  }
  const artifacts = path.join(store.tempDir, "artifacts");
  const archives = path.join(artifacts, "session-archives");
  const handoffRoot = path.join(store.tempDir, "handoff");
  fs.mkdirSync(archives, { recursive: true });
  fs.mkdirSync(handoffRoot);
  const handoff = installPrivateUpdateHandoffStore(handoffRoot);
  handoff.assertDatabasePath(resolveManagedUpdateLeaseDatabasePath());
  const guard = writePrivateUpdateHandoffChildGuard(handoff.databasePath, handoffRoot);
  const env = guard({
    ...store.env,
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "legacy-operator-state",
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
    OPENCLAW_UPGRADE_SURVIVOR_ARCHIVE_PROOF_ROOT: archives,
    OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
  });
  const assertion = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";
  const run = (...args: string[]) =>
    spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10_000 });
  const succeeds = (result: ReturnType<typeof run>) => expect(result.status, result.stderr).toBe(0);
  succeeds(run(assertion, "seed-legacy-operator-pending-delivery"));
  const original = fs.readFileSync(store.storePath, "utf8");
  const imported = await runDoctorSessionSqlite({
    env: store.env,
    mode: "import",
    agent: "ops",
    store: store.storePath,
  });
  expect(imported.targets[0]?.issues).toEqual([]);
  const manifestPath = imported.migrationRun!.manifestPath;
  const manifest = readMigrationManifest(manifestPath);
  const move = manifest.targets
    .flatMap((target) => target.completedMoves)
    .find((item) => item.kind === "legacy-store")!;
  expect(fs.readFileSync(move.archivePath, "utf8")).toBe(original);
  // The external service shim observes these real archives before restarting.
  succeeds(run(assertion, "capture-legacy-operator-pending-delivery", store.stateDir, artifacts));
  const updateJson = path.join(artifacts, "update.json");
  const updateErr = path.join(artifacts, "update.err");
  fs.writeFileSync(updateJson, "{}");
  fs.writeFileSync(updateErr, "");
  const verify = () =>
    run(assertion, "assert-legacy-operator-pending-delivery", updateJson, updateErr);
  succeeds(verify());
  for (const [key, value] of Object.entries(store.env)) {
    if (value !== undefined) {
      vi.stubEnv(key, value);
    }
  }
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const runId = createUpdateRun({ trigger: "cli" }, { env: store.env }).runId;
  const emit = await prepareUpdateCommandTerminalResult(
    { opts: { json: true, run: { runId, env: store.env } } },
    { status: "ok", mode: "git", steps: [], durationMs: 1 },
    { rolledBack: false },
  );
  const result = await emit();
  expect(result.status).toBe("ok");
  expect(getUpdateRun(runId, { env: store.env })?.status).toBe("succeeded");
  expect(fs.existsSync(move.archivePath)).toBe(false);
  const finished = readMigrationManifest(manifestPath);
  const retired = finished.targets
    .flatMap((target) => target.completedMoves)
    .find((item) => item.archivePath === move.archivePath)!;
  expect(retired.artifact?.disposal.state).toBe("disposed");
  succeeds(verify());
  // A missing original alone, another receipt, or an unobserved deletion cannot pass.
  const artifact = retired.artifact!;
  const { disposal, identity } = artifact;
  const editReceipt = (change: Partial<typeof artifact>) => {
    Object.assign(artifact, change);
    fs.writeFileSync(manifestPath, JSON.stringify(finished));
  };
  const proof = fs
    .readdirSync(archives)
    .map((name) => path.join(archives, name))
    .find((file) => fs.readFileSync(file, "utf8") === original)!;
  const parked = `${proof}.parked`;
  for (const [reason, corrupt, restore] of [
    [
      "archive missing without disposal receipt",
      () => editReceipt({ disposal: { state: "retained" } }),
      () => editReceipt({ disposal }),
    ],
    [
      "disposed archive digest changed",
      () => editReceipt({ identity: { ...identity, sha256: "0".repeat(64) } }),
      () => editReceipt({ identity }),
    ],
    ["ENOENT", () => fs.renameSync(proof, parked), () => fs.renameSync(parked, proof)],
    [
      "disposed session archive was recreated",
      () => fs.writeFileSync(move.archivePath, original),
      () => fs.unlinkSync(move.archivePath),
    ],
  ] as const) {
    corrupt();
    try {
      const rejected = verify();
      expect(rejected.status, reason).not.toBe(0);
      expect(rejected.stderr).toContain(reason);
    } finally {
      restore();
    }
  }
});
