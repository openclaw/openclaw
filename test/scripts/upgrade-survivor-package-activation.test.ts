import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { assertPackageRecoveryEvidence } from "../../scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const recoveryScript = "scripts/e2e/lib/upgrade-survivor/package-activation-recovery.mjs";
const faultImport = pathToFileURL(
  path.resolve("scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs"),
).href;
const runNode = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  runProcess(process.execPath, args, { ...process.env, ...env }, 10_000);
function faultFixture(
  cut: "publication-complete" | "verification" | "verification-rollback",
  preload: string[] = [],
) {
  const root = fs.realpathSync(dirs.make("package-activation-fault-"));
  const evidence = path.join(root, "cut.json");
  const journal = path.join(root, "operation.sqlite");
  const previousRoot = path.join(root, "previous");
  const spec = path.join(root, "fault.json");
  writeJson(spec, {
    cut,
    evidence,
    ...(cut.startsWith("verification") ? { previousRoot } : { journal }),
  });
  const run = (code: string, ...args: string[]) =>
    runNode([...preload, "--import", faultImport, "--input-type=module", "-e", code, ...args], {
      OPENCLAW_SURVIVOR_PACKAGE_FAULT: spec,
    });
  return { evidence, journal, previousRoot, run };
}
function writePackage(root: string, version: string, build: { buildId: string }) {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  writeJson(path.join(root, "package.json"), { version });
  writeJson(path.join(root, "dist/build-info.json"), build);
}

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

it("re-arms publication and Doctor faults when the same artifact directory is reused", () => {
  const artifacts = fs.realpathSync(dirs.make("package-recovery-rearm-"));
  const installed = path.join(artifacts, "installed");
  const packed = path.join(artifacts, "package");
  for (const [root, version, buildId] of [
    [installed, "2026.9.8", "released"],
    [packed, "2026.9.10", "candidate"],
  ] as const) {
    writePackage(root, version, { buildId });
  }
  const tarball = path.join(artifacts, "candidate.tgz");
  const pack = runProcess("tar", ["-czf", tarball, "-C", artifacts, "package"]);
  expect(pack.status, pack.stderr).toBe(0);
  const config = path.join(artifacts, "config.json");
  writeJson(config, { gateway: {}, plugins: { enabled: false } });
  const evidence = path.join(artifacts, "package-activation-cut.json");
  for (const cut of ["publication-complete", "verification"]) {
    fs.writeFileSync(evidence, '{"pid":"previous-run"}');
    fs.writeFileSync(`${evidence}.doctor`, '{"exitCode":1}');
    const setup = runNode([recoveryScript, "setup", artifacts, installed, tarball, cut, config]);
    expect(setup.status, setup.stderr).toBe(0);
    expect([evidence, `${evidence}.doctor`].map(fs.existsSync)).toEqual([false, false]);
    expect(readJson(path.join(artifacts, "package-activation-fault.json")).cut).toBe(cut);
  }
});
it.each(["run", "all"])("kills only after the selected real SQLite commit through %s", (method) => {
  const { journal, evidence, run } = faultFixture("publication-complete", ["--import=tsx"]);
  const result = run(`
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      import { executeSqliteQuerySync, getNodeSqliteKysely } from './src/infra/kysely-sync.ts';
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
    `);
  expect([result.error, result.signal], result.stderr).toEqual([undefined, "SIGKILL"]);
  const cut = readJson(evidence);
  expect(cut.row).toEqual({ slot: 1, phase: "publication-complete", intent_json: "null" });
  const db = new DatabaseSync(journal, { readOnly: true });
  try {
    expect({ ...db.prepare("SELECT * FROM package_activation").get() }).toEqual(cut.row);
  } finally {
    db.close();
  }
});
it.each([
  ["verification", "doctor"],
  ["verification-rollback", "doctor"],
  ["verification", "--doctor"],
  ["verification-rollback", "--doctor"],
] as const)(
  "fails the real Doctor child with the selected %s rollback policy through %s",
  (cut, doctorArg) => {
    const { evidence, previousRoot, run } = faultFixture(cut);
    fs.mkdirSync(previousRoot);
    const manifest = path.join(previousRoot, "package.json");
    fs.writeFileSync(manifest, '{"version":"2026.9.8"}');
    fs.writeFileSync(evidence, "{}");
    const result = run("throw new Error('Doctor body must not run')", "--", doctorArg);
    expect([result.error, result.status], result.stderr).toEqual([undefined, 1]);
    const expected = '{"version":"2026.9.8"}' + (cut === "verification" ? "\n" : "");
    expect(fs.readFileSync(manifest, "utf8")).toBe(expected);
    expect(readJson(`${evidence}.doctor`)).toMatchObject({
      exitCode: 1,
      manifestDigest: createHash("sha256").update(expected).digest("hex"),
    });
  },
);

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
  const writeSettings = (enabled: boolean) =>
    writeJson(configPath, { gateway, plugins: { enabled } });
  writeSettings(false);
  for (const tree of [root, previous]) {
    writePackage(tree, candidate.version, candidate.build);
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
  writeJson(evidence, { cut: "publication-complete" });
  writeJson(path.join(artifacts, "package-activation-fault.json"), {
    cut: "publication-complete",
    evidence,
    journal,
  });
  writeJson(path.join(artifacts, "package-activation-recovery.json"), {
    baseline: { version: "2026.9.8" },
    candidate,
    root,
    anchor,
    configPath,
    authoredSettings: { gateway, pluginsEnabled: false },
  });
  const run = (command: string, exit: string, error?: string) => {
    const result = runNode([recoveryScript, command, artifacts, exit]);
    if (error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    } else {
      expect(result.status, result.stderr).toBe(0);
    }
  };
  run("interrupted", "137");
  const retained = `${anchor}.superseded-fixture-operation`;
  fs.renameSync(anchor, retained);
  fs.renameSync(`${anchor}.control`, path.join(retained, "control"));
  run("repaired", "0");
  writeSettings(true);
  run("repaired", "0", "authored settings changed");
  writeSettings(false);
  for (const tree of [root, path.join(retained, "previous")]) {
    const runtime = path.join(tree, "dist/runtime.mjs");
    fs.writeFileSync(runtime, "damaged runtime bytes");
    run("repaired", "0", "package tree changed");
    fs.writeFileSync(runtime, "retained runtime bytes");
  }
});

const packageIdentity = (version: string, buildId: string) => ({ version, build: { buildId } });
function completeEvidence() {
  const installed = { ...packageIdentity("2026.9.11", "next"), manifest: "next-manifest" };
  const preserved = { exitCode: 0, retainedBytesPreserved: true, settingsPreserved: true };
  return {
    status: "passed",
    baseline: packageIdentity("2026.9.8", "published"),
    candidate: { ...packageIdentity("2026.9.10", "candidate"), tarballSha256: "a".repeat(64) },
    interruption: {
      phase: "publication-complete",
      cut: "publication-complete",
      writerVersion: "2026.9.8",
      helperPreserved: true,
    },
    repair: { ...preserved, candidateUnchanged: true },
    repeatRepair: { exitCode: 0, settingsPreserved: true },
    nextUpdate: { ...preserved, expected: installed, installed },
    targetSelector: "installed-candidate",
  };
}

it("requires a distinct real next update and preservation, not just successful repair", () => {
  expect(() => assertPackageRecoveryEvidence(completeEvidence())).not.toThrow();
  let evidence = completeEvidence();
  evidence.nextUpdate.installed = { ...evidence.nextUpdate.installed, version: "2026.9.10" };
  expect(() => assertPackageRecoveryEvidence(evidence)).toThrow();
  evidence = completeEvidence();
  evidence.nextUpdate.retainedBytesPreserved = false;
  expect(() => assertPackageRecoveryEvidence(evidence)).toThrow();
  evidence = completeEvidence();
  evidence.interruption.writerVersion = "2026.9.10";
  expect(() => assertPackageRecoveryEvidence(evidence)).toThrow();
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
