import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { startInstalledRecoveryRun } from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-observations.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readJson, runProcess, writeJson } from "./upgrade-survivor-shard.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const owner = path.resolve("scripts/e2e/lib/upgrade-survivor");
const secret = "sk-installedRecoveryDiagnosticSecret1234567890";
const privateData = "PRIVATE_CONFIG_AND_JOURNAL_FIELDS";

function fixture() {
  const root = fs.realpathSync(dirs.make("older-runtime-recovery-diagnostics-"));
  const artifacts = path.join(root, "artifacts");
  const state = path.join(root, "state");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(state);
  const run = startInstalledRecoveryRun(artifacts, "older-runtime");
  return {
    root,
    artifacts,
    state,
    run,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      NODE_OPTIONS: "--no-warnings",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    },
  };
}

function publish(artifacts: string, root: string) {
  const destination = path.join(root, "public");
  const coordinates = publishDiagnostics(artifacts, destination, redactSensitiveText);
  const text = fs.readFileSync(path.join(destination, "failure.json"), "utf8");
  expect(text).not.toContain(secret);
  expect(text).not.toContain(privateData);
  return { coordinates, report: JSON.parse(text) };
}

it("observes the refused notice without another service-manager command", () => {
  const f = fixture();
  const specPath = path.join(f.root, "observer.json");
  const paramsPath = path.join(f.root, "handoff.json");
  const helper = path.join(f.root, "helper.cjs");
  const stateDatabasePath = path.join(f.state, "openclaw.sqlite");
  const logPath = path.join(f.root, "helper.log");
  const noticeReceipt = path.join(f.root, "notice-receipt.json");
  const preservedNotice = path.join(f.root, "refused-notice.json");
  const row = {
    payload_json: JSON.stringify({ kind: "update", message: "unrelated" }),
    updated_at_ms: 42,
  };
  writeJson(specPath, {
    root: f.root,
    runId: "run",
    handoffId: "handoff",
    noticeReceipt,
    preservedNotice,
  });
  writeJson(paramsPath, {
    updateLeaseKey: f.root,
    runId: "run",
    handoffId: "handoff",
    action: "update",
    commandArgv: [node, path.join(f.root, "openclaw.mjs"), "update"],
    stateDatabasePath,
    logPath,
  });
  fs.writeFileSync(
    helper,
    `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    const spec = JSON.parse(fs.readFileSync(${JSON.stringify(specPath)}, 'utf8'));
    const params = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const db = new DatabaseSync(params.stateDatabasePath);
    db.exec('CREATE TABLE gateway_restart_sentinel (sentinel_key TEXT, payload_json TEXT, updated_at_ms INTEGER)');
    const row = ${JSON.stringify(row)};
    db.prepare('INSERT INTO gateway_restart_sentinel VALUES (?, ?, ?)').run('current', row.payload_json, row.updated_at_ms);
    const refusal = '[fixture] Update notice changed or belongs to another handoff; it was not replaced.\\n';
    fs.appendFileSync(params.logPath, refusal);
    assert(!fs.existsSync(spec.preservedNotice));
    fs.writeFileSync(spec.noticeReceipt, '{}');
    fs.appendFileSync(params.logPath + '.other', refusal);
    fs.appendFileSync(params.logPath, '[fixture] updater already verified recovery\\n');
    assert(!fs.existsSync(spec.preservedNotice));
    fs.appendFileSync(params.logPath, refusal, { mode: 0o600 });
    assert.deepEqual(JSON.parse(fs.readFileSync(spec.preservedNotice, 'utf8')), row);
    db.exec('DELETE FROM gateway_restart_sentinel');
    fs.appendFileSync(params.logPath, refusal);
    assert.deepEqual(JSON.parse(fs.readFileSync(spec.preservedNotice, 'utf8')), row);
    db.close();
  `,
  );
  const result = runProcess(
    node,
    ["--import", path.join(owner, "older-runtime-recovery-observer.mjs"), helper, paramsPath],
    {
      ...f.env,
      OPENCLAW_SURVIVOR_OLDER_RUNTIME: specPath,
    },
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readJson(preservedNotice)).toEqual(row);
  expect(fs.readFileSync(logPath, "utf8")).toContain("updater already verified recovery");
});

it.each(["available", "unavailable", "published-failure"])(
  "exits a rejected older-runtime startup with private evidence (%s)",
  (mode) => {
    const unavailable = mode === "unavailable";
    const publishedFailure = mode === "published-failure";
    const f = fixture();
    const baseline = path.join(f.root, "published");
    const candidate = path.join(f.root, "candidate");
    for (const [root, buildId] of [
      [baseline, "published"],
      [candidate, "candidate"],
    ] as const) {
      fs.mkdirSync(path.join(root, "dist/cli"), { recursive: true });
      writeJson(path.join(root, "package.json"), {
        name: "openclaw",
        type: "module",
        version: "2026.10.9",
      });
      writeJson(path.join(root, "dist/build-info.json"), {
        version: "2026.10.9",
        buildId,
        commit: "a".repeat(40),
      });
      fs.writeFileSync(path.join(root, "openclaw.mjs"), "");
      fs.writeFileSync(path.join(root, "dist/cli/daemon-cli.js"), "export {};\n");
    }
    // Fixture exports stop at startup rejection; the packaged lane owns restoration proof.
    fs.writeFileSync(
      path.join(baseline, "dist/cli/daemon-cli.js"),
      `globalThis[Symbol.for('openclaw.workerCpuSources')] = {};
       ${publishedFailure ? `process.stderr.write(${JSON.stringify(privateData)}); throw new Error(${JSON.stringify(secret)});` : ""}
       export {};\n`,
    );
    fs.mkdirSync(path.join(baseline, "dist/plugin-sdk"));
    fs.writeFileSync(
      path.join(baseline, "dist/plugin-sdk/plugin-state-store-runtime.js"),
      "export function createPluginStateSyncKeyedStore() { return { register() {} }; }\n",
    );
    fs.writeFileSync(
      path.join(baseline, "dist/update-run-ledger-fixture.mjs"),
      "function createUpdateRun() { return { runId: 'diagnostic-run' }; } export { createUpdateRun };\n",
    );
    fs.writeFileSync(
      path.join(candidate, "dist/update-managed-service-handoff-fixture.mjs"),
      `
      import { fail } from './failing-worker-fixture.mjs';
      async function startManagedServiceUpdateHandoff() {
        setInterval(() => {}, 1000);
        if (globalThis[Symbol.for('openclaw.workerCpuSources')]) {
          throw new Error('Published runtime contaminated the candidate process');
        }
        try { fail(); } catch (cause) {
          throw new Error(${JSON.stringify(secret)}, { cause });
        }
      }
      function transferManagedServiceUpdateHandoff() { throw new Error('unexpected transfer'); }
      export { startManagedServiceUpdateHandoff, transferManagedServiceUpdateHandoff };
    `,
    );
    fs.writeFileSync(
      path.join(candidate, "dist/failing-worker-fixture.mjs"),
      `export function fail() { throw new Error(${JSON.stringify(privateData)}); }\n`,
    );
    writeJson(f.env.OPENCLAW_CONFIG_PATH, { gateway: {}, plugins: { enabled: false } });
    const daemonLog = path.join(f.root, "gateway.log");
    writeJson(`${daemonLog}.runtime.json`, { pid: process.pid });
    const driverError = path.join(f.run.directory, "driver.err");
    if (unavailable) {
      fs.writeFileSync(driverError, "preserve existing evidence");
    }
    const result = runProcess(
      node,
      [
        path.join(owner, "older-runtime-recovery.mjs"),
        f.run.directory,
        candidate,
        baseline,
        path.join(f.root, "candidate.tgz"),
      ],
      {
        ...f.env,
        NODE_OPTIONS: "",
        OPENCLAW_TEST_WORKSPACE_DIR: path.join(f.root, "workspace"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: daemonLog,
      },
      10_000,
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      publishedFailure
        ? "phase=seed-published-runtime sites=older-runtime-recovery.mjs:"
        : "phase=start-candidate-handoff sites=failing-worker-fixture.mjs:",
    );
    expect(result.stderr).toContain(
      unavailable || publishedFailure
        ? "private driver diagnostic unavailable"
        : "inspect driver.err in the private run evidence",
    );
    expect(result.stderr).toMatch(/\[older-runtime-recovery\] FAILED \(exit 1\)\n$/u);
    expect(result.stderr.length).toBeLessThan(2048);
    for (const value of [secret, privateData, f.root]) {
      expect(result.stdout + result.stderr).not.toContain(value);
    }
    expect(fs.readFileSync(driverError, "utf8")).toContain(
      unavailable ? "preserve existing evidence" : secret,
    );
  },
);

it.skipIf(process.platform === "win32")(
  "captures install failure before teardown and preserves its exit",
  () => {
    const f = fixture();
    const harness = path.join(f.root, "harness");
    fs.mkdirSync(path.join(harness, "scripts/lib"), { recursive: true });
    fs.mkdirSync(path.join(harness, "scripts/e2e/lib"), { recursive: true });
    fs.symlinkSync(owner, path.join(harness, "scripts/e2e/lib/upgrade-survivor"), "dir");
    fs.writeFileSync(
      path.join(harness, "scripts/lib/openclaw-e2e-instance.sh"),
      `
    openclaw_e2e_eval_test_state_from_b64() { :; }
    openclaw_test_state_create() { :; }
    openclaw_e2e_install_package() {
      "$FIXTURE_NODE" -e 'console.error(process.env.FIXTURE_SECRET); process.exit(23)' >"$1" 2>&1
    }
  `,
    );
    const script = fs
      .readFileSync(path.join(owner, "installed-recovery.sh"), "utf8")
      .replaceAll("/tmp/openclaw-release-harness", harness)
      .replace("/tmp/openclaw-installed-recovery", path.join(f.root, "runtime"));
    const result = runProcess(
      "/bin/bash",
      ["-c", script],
      {
        ...f.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH ?? ""}`,
        FIXTURE_NODE: node,
        FIXTURE_SECRET: secret,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: f.artifacts,
        OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT: "older-runtime",
        OPENCLAW_TEST_STATE_FUNCTION_B64: "fixture",
      },
      10_000,
    );
    expect(result.status, result.stderr).toBe(23);
    const { coordinates, report } = publish(f.artifacts, f.root);
    expect(coordinates).toEqual({
      phase: "installed-recovery-install",
      exitStatus: 23,
      signal: null,
    });
    expect(report.installedRecovery.status).toBe("running");
    expect(report.installedRecovery.logs.install).not.toBeNull();
    expect(report.installedRecovery.runDirectory).toBe(readJson(f.run.summary).runDirectory);
    expect(report.installedRecovery.runDirectory).not.toBe(path.basename(f.run.directory));
  },
);
