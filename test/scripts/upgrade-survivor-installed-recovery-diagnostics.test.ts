import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const root = fs.realpathSync(dirs.make("installed-recovery-diagnostics-"));
  const artifacts = path.join(root, "artifacts");
  const state = path.join(root, "state");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(state);
  const run = startInstalledRecoveryRun(artifacts);
  const directory = path.join(run.directory, "partial-previous");
  fs.mkdirSync(directory);
  const current = {
    cut: "partial-previous",
    name: "displacement",
    state: "running",
    stdout: "partial-previous/displacement.out",
    stderr: "partial-previous/displacement.err",
  };
  writeJson(run.summary, {
    status: "running",
    runDirectory: path.basename(run.directory),
    selectedCuts: ["partial-previous"],
    current,
  });
  return {
    root,
    artifacts,
    state,
    run,
    directory,
    current,
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

function publish(f: ReturnType<typeof fixture>) {
  const destination = path.join(f.root, "public");
  const coordinates = publishDiagnostics(f.artifacts, destination, redactSensitiveText);
  const text = fs.readFileSync(path.join(destination, "failure.json"), "utf8");
  expect(text).not.toContain(secret);
  expect(text).not.toContain(privateData);
  return { coordinates, report: JSON.parse(text) };
}

function capture(f: ReturnType<typeof fixture>) {
  const result = runProcess(
    node,
    [
      path.join(owner, "diagnostics.mjs"),
      "capture",
      f.artifacts,
      "installed-recovery-command",
      "1",
      "",
      f.run.directory,
    ],
    f.env,
    10_000,
  );
  expect(result.status, result.stderr).toBe(0);
  return publish(f).report;
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

it.skipIf(process.platform !== "linux").each([
  {
    name: "keeps unexpected command output private until diagnostic publication",
    failure: "command",
  },
  { name: "keeps early JSON parse snippets in private driver evidence", failure: "json" },
  { name: "keeps early assertion values in private driver evidence", failure: "assertion" },
  { name: "keeps encoded assertion values in private driver evidence", failure: "encoded" },
  { name: "fails safely when private driver evidence cannot be opened", failure: "capture" },
])("$name", ({ failure }) => {
  const f = fixture();
  fs.rmdirSync(f.directory);
  const prefix = path.join(f.root, "prefix");
  const installed = path.join(prefix, "lib/node_modules/openclaw");
  const packed = path.join(f.root, "package");
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packed, "dist"), { recursive: true });
  const manifest = { version: "2026.10.6", openclaw: { schemaVersions: {} } };
  writeJson(path.join(installed, "package.json"), manifest);
  writeJson(path.join(packed, "package.json"), manifest);
  const parseInput = "token=abc";
  if (failure === "json") {
    fs.writeFileSync(path.join(packed, "package.json"), parseInput);
  } else if (failure === "assertion" || failure === "encoded") {
    writeJson(path.join(installed, "package.json"), {
      ...manifest,
      version: failure === "assertion" ? secret : { encoded: [...Buffer.from(secret)] },
    });
  }
  const driverError = path.join(f.run.directory, "driver.err");
  if (failure !== "command") {
    writeJson(f.run.summary, { ...readJson(f.run.summary), current: null });
  }
  if (failure === "capture") {
    const outside = path.join(f.root, "outside-driver.err");
    fs.writeFileSync(outside, privateData);
    fs.symlinkSync(outside, driverError);
  }
  writeJson(path.join(packed, "dist/build-info.json"), { version: manifest.version });
  writeJson(path.join(packed, "dist/postinstall-inventory.json"), []);
  fs.writeFileSync(path.join(packed, "dist/package-update-activation-recovery.mjs"), "");
  fs.writeFileSync(
    path.join(prefix, "bin/openclaw"),
    `process.stderr.write(${JSON.stringify(`token=${secret}\n`)});`,
  );
  writeJson(f.env.OPENCLAW_CONFIG_PATH, {});
  const tarball = path.join(f.root, "candidate.tgz");
  const archive = runProcess("tar", ["-czf", tarball, "-C", f.root, "package"], f.env, 10_000);
  expect(archive.status, archive.stderr).toBe(0);
  const result = runProcess(
    node,
    [
      path.join(owner, "installed-recovery.mjs"),
      f.run.directory,
      prefix,
      tarball,
      f.env.OPENCLAW_CONFIG_PATH,
      f.run.summary,
      "partial-previous",
    ],
    { ...f.env, OPENCLAW_E2E_COMMAND_TIMEOUT: "2s" },
    10_000,
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toBe(
    `${failure === "capture" ? "[installed-recovery] private driver diagnostic unavailable" : "[installed-recovery] inspect driver.err in the private run evidence"}\n` +
      "[installed-recovery] FAILED (exit 1)\n",
  );
  expect(result.stdout + result.stderr).not.toContain(secret);
  const rawError = fs.readFileSync(driverError, "utf8");
  if (failure === "capture") {
    expect(rawError).toBe(privateData);
  } else {
    expect(fs.statSync(driverError).mode & 0o777).toBe(0o600);
    expect(rawError).toContain(
      failure === "command"
        ? "displacement: exit 0"
        : failure === "json"
          ? parseInput
          : failure === "encoded"
            ? "encoded:"
            : secret,
    );
  }
  if (failure === "command") {
    expect(fs.readFileSync(path.join(f.directory, "displacement.err"), "utf8")).toContain(secret);
    expect(readJson(f.run.summary).current).toMatchObject({
      name: "displacement",
      state: "completed",
      status: 0,
      treeJoined: true,
    });
  } else {
    expect(readJson(f.run.summary).current).toBeNull();
  }
  const report = capture(f);
  expect(report.installedRecovery.driverError).toEqual({
    availability: failure === "capture" ? "unavailable" : "captured",
  });
  const published = JSON.stringify(report);
  expect(published).not.toContain(parseInput);
  expect(published).not.toContain("encoded");
  expect(published).not.toContain("AssertionError");
  if (failure === "command") {
    expect(report.installedRecovery.logs.stderr).toContain("token=");
    expect(report.installedRecovery.logs.stderr).not.toContain(secret);
    expect(report.installedRecovery.current).toMatchObject({
      state: "completed",
      status: 0,
      treeJoined: true,
    });
  }
});

it.skipIf(process.platform === "win32")(
  "publishes the real rejected command's output without inventing an exit or join receipt",
  () => {
    const f = fixture();
    const commandOwner = pathToFileURL(path.join(owner, "installed-recovery-command.mjs")).href;
    const stdout = path.join(f.run.directory, f.current.stdout);
    const stderr = path.join(f.run.directory, f.current.stderr);
    const pidFile = path.join(f.root, "child.pid");
    const result = runProcess(
      node,
      [
        "--input-type=module",
        "-e",
        `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { runInstalledRecoveryCommand } from ${JSON.stringify(commandOwner)};
    const summary = ${JSON.stringify(f.run.summary)};
    const evidence = JSON.parse(fs.readFileSync(summary, 'utf8'));
    const states = [];
    const out = ${JSON.stringify(stdout)}, err = ${JSON.stringify(stderr)};
    const opened = [];
    const openSync = fs.openSync;
    fs.openSync = (...args) => {
      const fd = openSync(...args);
      if (args[0] === out || args[0] === err) opened.push(fd);
      return fd;
    };
    try {
      await assert.rejects(runInstalledRecoveryCommand({
      bin: process.execPath,
      args: ['-e', ${JSON.stringify(`
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        process.stdout.write('phase: candidate staging\\n');
        process.stderr.write('token=${secret}\\n');
        setInterval(() => {}, 1000);
      `)}],
      env: process.env, stdout: out, stderr: err, timeout: '2s', timeoutKillGraceMs: 100,
      record(state) {
        states.push(state.state);
        evidence.current = { ...evidence.current, ...state };
        fs.writeFileSync(summary, JSON.stringify(evidence));
      },
      }), { code: 'ETIMEDOUT' });
    } finally {
      fs.openSync = openSync;
    }
    assert.deepEqual(states, ['running', 'rejected']);
    assert.equal('status' in evidence.current, false);
    assert.equal('treeJoined' in evidence.current, false);
    const pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(opened.length, 2);
    for (const fd of opened) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  `,
      ],
      f.env,
      10_000,
    );
    expect(result.status, result.stderr).toBe(0);
    writeJson(path.join(f.directory, "displacement.fault.json.observed"), {
      cut: "displaced",
      synced: false,
      row: {
        phase: "publishing",
        intent_json: JSON.stringify({ kind: "displace" }),
        descriptor_json: privateData,
        secret,
      },
    });
    const report = capture(f);
    expect(report.installedRecovery.current).toMatchObject({
      cut: "partial-previous",
      name: "displacement",
      state: "rejected",
      error: "Managed command timed out after 2000ms",
    });
    expect(report.installedRecovery.current).not.toHaveProperty("status");
    expect(report.installedRecovery.current).not.toHaveProperty("treeJoined");
    expect(report.installedRecovery.logs.stdout).toBe("phase: candidate staging\n");
    expect(report.installedRecovery.logs.stderr).toContain("token=");
    expect(report.installedRecovery.checkpoint).toEqual({
      availability: "captured",
      cut: "displaced",
      phase: "publishing",
      intent: "displace",
      synced: false,
    });
  },
);

it.skipIf(process.platform === "win32").each(["", "0"])(
  "preserves the disabled inner command watchdog: %j",
  (timeout) => {
    const f = fixture();
    const commandOwner = pathToFileURL(path.join(owner, "installed-recovery-command.mjs")).href;
    const result = runProcess(
      node,
      [
        "--input-type=module",
        "-e",
        `
    import assert from 'node:assert/strict';
    import { runInstalledRecoveryCommand } from ${JSON.stringify(commandOwner)};
    const states = [];
    const result = await runInstalledRecoveryCommand({
      bin: process.execPath,
      args: ['-e', 'setTimeout(() => process.stdout.write("finished"), 30)'],
      env: process.env,
      stdout: ${JSON.stringify(path.join(f.run.directory, "disabled.out"))},
      stderr: ${JSON.stringify(path.join(f.run.directory, "disabled.err"))},
      timeout: ${JSON.stringify(timeout)}, timeoutKillGraceMs: 100,
      record: state => states.push(state),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'finished');
    assert.deepEqual(states.map(state => state.state), ['running', 'completed']);
    assert.equal(states.at(-1).treeJoined, true);
  `,
      ],
      f.env,
      10_000,
    );
    expect(result.status, result.stderr).toBe(0);
  },
);

it.each(["stale", "symlink", "oversize", "partial-checkpoint"])(
  "retains only current safe evidence for %s input",
  (fault) => {
    const f = fixture();
    const stdout = path.join(f.run.directory, f.current.stdout);
    const stderr = path.join(f.run.directory, f.current.stderr);
    fs.writeFileSync(stdout, "current phase\n");
    fs.writeFileSync(stderr, `token=${secret}\n`);
    if (fault === "stale") {
      startInstalledRecoveryRun(f.artifacts);
    } else if (fault === "symlink") {
      const outside = path.join(f.root, "outside");
      fs.writeFileSync(outside, privateData);
      fs.unlinkSync(stdout);
      fs.symlinkSync(outside, stdout);
    } else if (fault === "oversize") {
      fs.writeFileSync(stdout, "x".repeat(256 * 1024 + 1));
      fs.writeFileSync(stderr, `token=${secret}\n${"bounded line\n".repeat(2000)}`);
    } else {
      fs.writeFileSync(path.join(f.directory, "displacement.fault.json.observed"), "{");
    }
    const report = capture(f);
    if (fault === "stale") {
      expect(report.installedRecovery).toEqual({ availability: "unavailable" });
      expect(JSON.stringify(report)).not.toContain("current phase");
    } else {
      expect(report.installedRecovery.current).toEqual(f.current);
      expect(report.installedRecovery.checkpoint).toEqual({ availability: "unavailable" });
      expect(report.installedRecovery.logs.stdout).toBe(
        fault === "partial-checkpoint" ? "current phase\n" : null,
      );
      if (fault === "symlink") {
        expect(report.omissions["installed recovery stdout"]).toBe("missing or unsafe file");
      } else if (fault === "oversize") {
        expect(report.omissions["installed recovery stdout"]).toBe(
          "input exceeds cap; omitted whole",
        );
        expect(report.omissions["installed recovery stderr"]).toBe(
          "redacted output truncated at a complete line (16 KiB)",
        );
        expect(
          Buffer.byteLength(JSON.stringify(report.installedRecovery.logs.stderr)),
        ).toBeLessThanOrEqual(16 * 1024);
      } else {
        expect(report.omissions["installed recovery checkpoint"]).toBe(
          "invalid observation; omitted",
        );
      }
    }
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
        OPENCLAW_TEST_STATE_FUNCTION_B64: "fixture",
      },
      10_000,
    );
    expect(result.status, result.stderr).toBe(23);
    const { coordinates, report } = publish(f);
    expect(coordinates).toEqual({
      phase: "installed-recovery-install",
      exitStatus: 23,
      signal: null,
    });
    expect(report.installedRecovery.status).toBe("running");
    expect(report.installedRecovery.current).toBeNull();
    expect(report.installedRecovery.logs.install).not.toBeNull();
    expect(report.installedRecovery.runDirectory).toBe(readJson(f.run.summary).runDirectory);
    expect(report.installedRecovery.runDirectory).not.toBe(path.basename(f.run.directory));
  },
);
