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
      env: process.env, stdout: out, stderr: err, timeoutMs: 2000, timeoutKillGraceMs: 100,
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
