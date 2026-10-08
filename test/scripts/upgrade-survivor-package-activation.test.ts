import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertPackageRecoveryEvidence } from "../../scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "package-publication-recovery",
  "package-verification-recovery",
  "package-stranded-first-hop",
])("keeps %s live package journals on runtime storage, not the artifact mount", (scenario) => {
  const paths = readUpgradeSurvivorPaths("/tmp/package-recovery-paths", {
    OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
  });
  expect(paths.npmPrefix).toBe(path.join(paths.runtimeRoot, "npm-prefix"));
  expect(paths.summaryJson).toBe(path.join(paths.artifactRoot, "summary.json"));
});

describe("release package interruption fixture", () => {
  it("re-arms publication and Doctor faults when the same artifact directory is reused", () => {
    const artifacts = fs.realpathSync(dirs.make("package-recovery-rearm-"));
    const installed = path.join(artifacts, "installed");
    const packed = path.join(artifacts, "package");
    for (const [root, version, buildId] of [
      [installed, "2026.9.8", "released"],
      [packed, "2026.9.10", "candidate"],
    ] as const) {
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
      fs.writeFileSync(path.join(root, "dist/build-info.json"), JSON.stringify({ buildId }));
    }
    const tarball = path.join(artifacts, "candidate.tgz");
    const pack = spawnSync("tar", ["-czf", tarball, "-C", artifacts, "package"], {
      encoding: "utf8",
    });
    expect(pack.status, pack.stderr).toBe(0);
    const config = path.join(artifacts, "config.json");
    fs.writeFileSync(config, JSON.stringify({ gateway: {}, plugins: { enabled: false } }));
    const evidence = path.join(artifacts, "package-activation-cut.json");
    for (const cut of ["publication-complete", "verification"]) {
      fs.writeFileSync(evidence, '{"pid":"previous-run"}');
      fs.writeFileSync(`${evidence}.doctor`, '{"exitCode":1}');
      const setup = spawnSync(
        process.execPath,
        [
          "scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs",
          "setup",
          artifacts,
          installed,
          tarball,
          cut,
          config,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(setup.status, setup.stderr).toBe(0);
      expect(fs.existsSync(evidence)).toBe(false);
      expect(fs.existsSync(`${evidence}.doctor`)).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(artifacts, "package-activation-fault.json"), "utf8"))
          .cut,
      ).toBe(cut);
    }
  });
  it.each(["run", "all"])(
    "kills only after the selected real SQLite commit through %s",
    (method) => {
      const root = fs.realpathSync(dirs.make("package-activation-fault-"));
      const journal = path.join(root, "operation.sqlite");
      const evidence = path.join(root, "cut.json");
      const hook = pathToFileURL(
        path.resolve("scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs"),
      ).href;
      const result = spawnSync(
        process.execPath,
        [
          "--import=tsx",
          "--input-type=module",
          "-e",
          `
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import { executeSqliteQuerySync, getNodeSqliteKysely } from './src/infra/kysely-sync.ts';
      import { installPackageActivationFault } from ${JSON.stringify(hook)};
      installPackageActivationFault({ journal: ${JSON.stringify(journal)}, evidence: ${JSON.stringify(evidence)}, cut: 'publication-complete', terminate: () => process.kill(process.pid, 'SIGKILL') });
      const db = new DatabaseSync(${JSON.stringify(journal)});
      db.exec('CREATE TABLE package_activation(slot INTEGER, phase TEXT, intent_json TEXT)');
      db.exec('BEGIN');
      db.prepare('INSERT INTO "package_activation" VALUES(1,?,?)')[${JSON.stringify(method)}]('prepared', 'null');
      db.prepare('COMMIT').run();
      db.exec('BEGIN');
      db.prepare('UPDATE "package_activation" SET phase=?')[${JSON.stringify(method)}]('publication-complete');
      db.exec('ROLLBACK');
      if (fs.existsSync(${JSON.stringify(evidence)})) throw new Error('fault observed uncommitted state');
      db.exec('BEGIN');
      const query = getNodeSqliteKysely(db).updateTable('package_activation').set({ phase: 'publication-complete' });
      executeSqliteQuerySync(db, ${JSON.stringify(method)} === 'all' ? query.returningAll() : query);
      db.exec('COMMIT');
      throw new Error('fault did not terminate the updater');
    `,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal, result.stderr).toBe("SIGKILL");
      const cut = JSON.parse(fs.readFileSync(evidence, "utf8"));
      expect(cut.row).toEqual({ slot: 1, phase: "publication-complete", intent_json: "null" });
      const db = new DatabaseSync(journal, { readOnly: true });
      try {
        expect({ ...db.prepare("SELECT * FROM package_activation").get() }).toEqual(cut.row);
      } finally {
        db.close();
      }
    },
  );
  it("changes retained rollback bytes inside the Doctor child before reporting failure", () => {
    const root = fs.realpathSync(dirs.make("package-activation-doctor-"));
    const evidence = path.join(root, "cut.json");
    const previousRoot = path.join(root, "previous");
    fs.mkdirSync(previousRoot);
    const manifest = path.join(previousRoot, "package.json");
    fs.writeFileSync(manifest, '{"version":"2026.9.8"}');
    fs.writeFileSync(evidence, "{}");
    const spec = path.join(root, "fault.json");
    fs.writeFileSync(spec, JSON.stringify({ cut: "verification", evidence, previousRoot }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs"),
        "--input-type=module",
        "-e",
        "throw new Error('Doctor body must not run')",
        "doctor",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_SURVIVOR_PACKAGE_FAULT: spec },
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(fs.readFileSync(manifest, "utf8")).toBe('{"version":"2026.9.8"}\n');
    expect(JSON.parse(fs.readFileSync(`${evidence}.doctor`, "utf8"))).toMatchObject({
      exitCode: 1,
    });
  });
});

it("rejects repair receipts after non-manifest bytes change in either package tree", () => {
  const artifacts = fs.realpathSync(dirs.make("package-recovery-tree-"));
  const root = path.join(artifacts, "installed");
  const anchor = path.join(artifacts, "activation");
  const previous = path.join(anchor, "previous");
  const candidate = { version: "2026.9.10", build: { buildId: "candidate" } };
  const configPath = path.join(artifacts, "openclaw.json");
  const gateway = {
    mode: "local",
    port: 18789,
    bind: "loopback",
    reload: { mode: "off" },
    auth: { mode: "token" },
  };
  fs.writeFileSync(configPath, JSON.stringify({ gateway, plugins: { enabled: false } }));
  for (const tree of [root, previous]) {
    fs.mkdirSync(path.join(tree, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(tree, "package.json"),
      JSON.stringify({ version: candidate.version }),
    );
    fs.writeFileSync(path.join(tree, "dist/build-info.json"), JSON.stringify(candidate.build));
    fs.writeFileSync(path.join(tree, "dist/runtime.mjs"), "retained runtime bytes");
  }
  fs.mkdirSync(`${anchor}.control`);
  const helper = "released recovery helper fixture";
  fs.writeFileSync(path.join(`${anchor}.control`, "recovery.mjs"), helper);
  const journal = path.join(artifacts, "operation.sqlite");
  const db = new DatabaseSync(journal);
  db.exec("CREATE TABLE package_activation(slot INTEGER, phase TEXT, descriptor_json TEXT)");
  db.prepare("INSERT INTO package_activation VALUES(1,?,?)").run(
    "publication-complete",
    JSON.stringify({
      previous: { version: "2026.9.8" },
      candidate: { version: candidate.version },
      operationId: "fixture-operation",
      helperDigest: createHash("sha256").update(helper).digest("hex"),
    }),
  );
  db.close();
  const evidence = path.join(artifacts, "cut.json");
  fs.writeFileSync(evidence, JSON.stringify({ cut: "publication-complete" }));
  fs.writeFileSync(
    path.join(artifacts, "package-activation-fault.json"),
    JSON.stringify({ cut: "publication-complete", evidence, journal }),
  );
  fs.writeFileSync(
    path.join(artifacts, "package-activation-recovery.json"),
    JSON.stringify({
      baseline: { version: "2026.9.8" },
      candidate,
      root,
      anchor,
      configPath,
      authoredSettings: { gateway, pluginsEnabled: false },
    }),
  );
  const run = (command: string, exit: string) =>
    spawnSync(
      process.execPath,
      [
        "scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs",
        command,
        artifacts,
        exit,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
  const interrupted = run("interrupted", "137");
  expect(interrupted.status, interrupted.stderr).toBe(0);
  const retained = `${anchor}.superseded-fixture-operation`;
  fs.renameSync(anchor, retained);
  fs.renameSync(`${anchor}.control`, path.join(retained, "control"));
  const repaired = run("repaired", "0");
  expect(repaired.status, repaired.stderr).toBe(0);
  fs.writeFileSync(configPath, JSON.stringify({ gateway, plugins: { enabled: true } }));
  const changedSettings = run("repaired", "0");
  expect(changedSettings.status).not.toBe(0);
  expect(changedSettings.stderr).toContain("authored settings changed");
  fs.writeFileSync(configPath, JSON.stringify({ gateway, plugins: { enabled: false } }));
  for (const tree of [root, path.join(retained, "previous")]) {
    const runtime = path.join(tree, "dist/runtime.mjs");
    fs.writeFileSync(runtime, "damaged runtime bytes");
    const rejected = run("repaired", "0");
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("package tree changed");
    fs.writeFileSync(runtime, "retained runtime bytes");
  }
});

function completeEvidence() {
  const installed = { version: "2026.9.11", build: { buildId: "next" }, manifest: "next-manifest" };
  return {
    status: "passed",
    baseline: { version: "2026.9.8", build: { buildId: "published" } },
    candidate: {
      version: "2026.9.10",
      build: { buildId: "candidate" },
      tarballSha256: "a".repeat(64),
    },
    interruption: {
      phase: "publication-complete",
      cut: "publication-complete",
      writerVersion: "2026.9.8",
      helperPreserved: true,
    },
    repair: {
      exitCode: 0,
      retainedBytesPreserved: true,
      candidateUnchanged: true,
      settingsPreserved: true,
    },
    repeatRepair: { exitCode: 0, settingsPreserved: true },
    nextUpdate: {
      exitCode: 0,
      expected: installed,
      installed,
      retainedBytesPreserved: true,
      settingsPreserved: true,
    },
    targetSelector: "installed-candidate",
  };
}

describe("release package recovery evidence", () => {
  it("requires a distinct real next update and preservation, not just successful repair", () => {
    expect(() => assertPackageRecoveryEvidence(completeEvidence())).not.toThrow();
    const missingNext = completeEvidence();
    missingNext.nextUpdate.installed = {
      ...missingNext.nextUpdate.installed,
      version: "2026.9.10",
    };
    expect(() => assertPackageRecoveryEvidence(missingNext)).toThrow();
    const removedEvidence = completeEvidence();
    removedEvidence.nextUpdate.retainedBytesPreserved = false;
    expect(() => assertPackageRecoveryEvidence(removedEvidence)).toThrow();
    const substitutedWriter = completeEvidence();
    substitutedWriter.interruption.writerVersion = "2026.9.10";
    expect(() => assertPackageRecoveryEvidence(substitutedWriter)).toThrow();
    const stranded = {
      status: "passed",
      baseline: { version: "2026.9.7" },
      candidate: { version: "2026.9.8" },
      interruption: { writerVersion: "2026.9.7", phase: "publication-complete" },
      targetSelector: "unmodified-released-9.8",
      firstHop: {
        status: "blocked-before-staging",
        reason: "update-recovery-pending",
        installedVersion: "2026.9.8",
        targetWasAbsent: true,
        candidateCodeInvoked: false,
      },
    };
    expect(() => assertPackageRecoveryEvidence(stranded)).not.toThrow();
    stranded.firstHop.reason = "package-install-failed";
    expect(() => assertPackageRecoveryEvidence(stranded)).toThrow();
  });
});
