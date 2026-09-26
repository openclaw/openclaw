import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");
const sibling = path.resolve("scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs");
const secret = "sk-survivorMigrationCaptureSecret1234567890";
const privateBody = "PRIVATE_TRANSCRIPT_CONFIG_AND_UNLISTED_FIELDS";
const baselineGatewayLogs = [
  "missing-load-path/baseline-gateway.log",
  "missing-load-path/baseline-gateway-convergence-refusal.log",
];
const cronCliLogs = [
  ...["default", "ops"].flatMap((owner) =>
    ["out", "err"].map((extension) => `legacy-operator-run-survivor-${owner}-owner.${extension}`),
  ),
  "legacy-operator-post-update-transcript-0.out",
  "legacy-operator-post-update-transcript-0.err",
  "legacy-operator-candidate-transcript-1-earlier.out",
  "legacy-operator-candidate-transcript-1-earlier.err",
];
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture() {
  const root = fs.realpathSync(dirs.make("survivor-migration-capture-"));
  const artifacts = path.join(root, "artifacts");
  const state = path.join(root, "state");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(path.join(root, "openclaw-upgrade-survivor"));
  fs.mkdirSync(path.join(state, "state"), { recursive: true });
  return {
    root,
    artifacts,
    state,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      NODE_OPTIONS: "--no-warnings",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: "2026.9.4",
    },
  };
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function capture(f: ReturnType<typeof fixture>, outcome: "failed" | "passed" = "failed") {
  const result = spawnSync(
    node,
    [observer, "capture", f.artifacts, "update-candidate", "1", "", f.artifacts],
    { env: f.env, encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = path.join(f.root, "public");
  publishDiagnostics(f.artifacts, output, redactSensitiveText, outcome);
  const text = fs.readFileSync(
    path.join(output, outcome === "passed" ? "summary.json" : "failure.json"),
    "utf8",
  );
  expect(text).not.toContain(secret);
  expect(text).not.toContain(privateBody);
  return JSON.parse(text);
}

function pluginPolicyReceipt() {
  return {
    baselineVersion: "2026.9.2",
    candidateVersion: "2026.9.6",
    oldAllowlist: ["webhooks"],
    baselineEnabledPlugins: ["memory-core", "telegram"],
    candidateEnabledPlugins: ["memory-core", "telegram"],
    activePlugins: ["memory-core"],
    configuredChannelPlugin: "telegram",
    selectedMemoryPlugin: "memory-core",
    deniedPlugins: ["device-pair"],
    ordinaryHooksPreserved: true,
    hooksSha256: "a".repeat(64),
    hookUnauthorizedStatus: 401,
  };
}

function policySuccessSummary(pluginPolicy: unknown) {
  return {
    status: "passed",
    baseline: { spec: "openclaw@2026.9.2", version: "2026.9.2" },
    candidate: { kind: "tarball", version: "2026.9.6" },
    scenario: "legacy-operator-state",
    installedVersion: "2026.9.6",
    candidateInstallMode: "updater",
    updateRestartMode: "manual",
    updateOutcome: "success",
    phases: [],
    pluginPolicy,
  };
}

it("preserves historical success receipts without adopting policy sidecars", () => {
  const f = fixture();
  write(path.join(f.artifacts, "summary.json"), policySuccessSummary(undefined));
  write(path.join(f.artifacts, "webhooks-only-policy/result.json"), { privateBody });
  const report = capture(f, "passed");
  expect(report).not.toHaveProperty("pluginPolicy");
  expect(report.logs).not.toHaveProperty("webhooks-only-policy/result.json");
});

it("requires policy evidence when a successful receipt records the completed probe", () => {
  const f = fixture();
  write(path.join(f.artifacts, "summary.json"), {
    ...policySuccessSummary(undefined),
    phases: [
      { phase: "verify-sole-plugin-policy", status: "passed", at: "2026-09-25T12:00:00.000Z" },
    ],
  });
  expect(() =>
    publishDiagnostics(f.artifacts, path.join(f.root, "public"), redactSensitiveText, "passed"),
  ).toThrow("Missing sole-plugin policy evidence after completed probe");
});

it("publishes bounded redacted sole-policy success evidence without private configuration", () => {
  const f = fixture();
  const policy = pluginPolicyReceipt();
  write(path.join(f.artifacts, "summary.json"), policySuccessSummary({ ...policy, privateBody }));
  write(path.join(f.artifacts, "webhooks-only-policy/result.json"), policy);
  write(path.join(f.artifacts, "webhooks-only-policy/update.json"), {
    status: "ok",
    before: { version: "2026.9.2" },
    after: { version: "2026.9.6" },
    warning: `token=${secret}`,
  });
  write(path.join(f.artifacts, "webhooks-only-policy/candidate-runtime.out"), {
    plugins: [{ id: "telegram", enabled: true, runtime: { state: "unloaded" } }],
    warning: `token=${secret}`,
  });
  write(path.join(f.artifacts, "webhooks-only-policy/baseline-runtime.out"), {
    plugins: [{ id: "telegram", installed: true, enabled: true, state: "enabled" }],
  });
  write(path.join(f.artifacts, "webhooks-only-policy/openclaw.json"), { privateBody, secret });
  const report = capture(f, "passed");
  expect(report.pluginPolicy).toEqual(policy);
  expect(JSON.parse(report.logs["webhooks-only-policy/result.json"])).toEqual(policy);
  expect(JSON.parse(report.logs["webhooks-only-policy/update.json"])).toMatchObject({
    before: { version: "2026.9.2" },
    after: { version: "2026.9.6" },
  });
  expect(JSON.parse(report.logs["webhooks-only-policy/candidate-runtime.out"]).plugins).toEqual([
    { id: "telegram", enabled: true, runtime: { state: "unloaded" } },
  ]);
  expect(JSON.parse(report.logs["webhooks-only-policy/baseline-runtime.out"]).plugins).toEqual([
    { id: "telegram", installed: true, enabled: true, state: "enabled" },
  ]);
  expect(report.logs).not.toHaveProperty("webhooks-only-policy/openclaw.json");
});

it("keeps policy log limits and symlink protections on successful publication", () => {
  const f = fixture();
  write(path.join(f.artifacts, "summary.json"), policySuccessSummary(pluginPolicyReceipt()));
  const policyRoot = path.join(f.artifacts, "webhooks-only-policy");
  fs.mkdirSync(policyRoot);
  const outside = path.join(f.root, "outside.json");
  write(outside, { privateBody });
  fs.symlinkSync(outside, path.join(policyRoot, "result.json"));
  fs.writeFileSync(path.join(policyRoot, "update.json"), "x".repeat(256 * 1024 + 1));
  const report = capture(f, "passed");
  expect(report.logs["webhooks-only-policy/result.json"]).toBeNull();
  expect(report.omissions["webhooks-only-policy/result.json"]).toBe("missing or unsafe file");
  expect(report.logs["webhooks-only-policy/update.json"]).toBeNull();
  expect(report.omissions["webhooks-only-policy/update.json"]).toBe(
    "input exceeds cap; omitted whole",
  );
});

it.each([
  { candidateVersion: "2026.9.5" },
  { activePlugins: ["device-pair"] },
  { candidateEnabledPlugins: ["memory-core", "telegram", "unrelated"] },
  { candidateEnabledPlugins: ["telegram"] },
  { baselineEnabledPlugins: [] },
  { hookUnauthorizedStatus: 200 },
  { hooksSha256: "invalid" },
  { ordinaryHooksPreserved: false },
])("rejects inconsistent sole-policy success receipts: %j", (patch) => {
  const f = fixture();
  write(
    path.join(f.artifacts, "summary.json"),
    policySuccessSummary({ ...pluginPolicyReceipt(), ...patch }),
  );
  expect(() =>
    publishDiagnostics(f.artifacts, path.join(f.root, "public"), redactSensitiveText, "passed"),
  ).toThrow("Invalid sole-plugin policy evidence");
});

it.each(["failed", "passed"] as const)(
  "retains redacted sibling refusal evidence after a %s attempt",
  (outcome) => {
    const f = fixture();
    write(path.join(f.artifacts, "summary.json"), {
      status: "passed",
      baseline: { spec: "openclaw@2026.9.6", version: "2026.9.6" },
      candidate: { kind: "tarball", version: "2026.9.5" },
      scenario: "custom-plugin-siblings",
      installedVersion: "2026.9.5",
      candidateInstallMode: "npm",
      updateRestartMode: "manual",
      updateOutcome: "success",
      phases: [],
    });
    write(path.join(f.artifacts, "update.json"), { status: "ok", runId: "healthy-retry" });
    write(path.join(f.artifacts, "sibling-refusal-update.json"), {
      status: "error",
      runId: "refused-run",
      reason: `output-limit; token=${secret}`,
    });
    write(path.join(f.artifacts, "sibling-refusal-status.json"), {
      lastRun: { runId: "refused-run", status: "failed" },
    });
    write(path.join(f.artifacts, "sibling-refusal-worker.json"), { worker: { pid: 123 } });
    write(path.join(f.artifacts, "sibling-refusal-cleanup.json"), { survivors: [] });
    const report = capture(f, outcome);
    expect(JSON.parse(report.logs["update.json"]).runId).toBe("healthy-retry");
    expect(JSON.parse(report.logs["sibling-refusal-update.json"])).toMatchObject({
      status: "error",
      runId: "refused-run",
      reason: expect.stringContaining("output-limit"),
    });
    expect(JSON.parse(report.logs["sibling-refusal-status.json"]).lastRun.runId).toBe(
      "refused-run",
    );
    expect(JSON.parse(report.logs["sibling-refusal-worker.json"]).worker.pid).toBe(123);
    expect(JSON.parse(report.logs["sibling-refusal-cleanup.json"]).survivors).toEqual([]);
  },
);

function integrityLog(f: ReturnType<typeof fixture>, telemetry: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(f.root, "openclaw-upgrade-survivor", "gateway.jsonl"),
    JSON.stringify({
      0: JSON.stringify({ subsystem: "update/package-integrity" }),
      1: telemetry,
      2: telemetry.event,
      message: telemetry.event,
      _meta: { logLevelName: "DEBUG", path: privateBody },
      privateBody,
    }) + "\n",
  );
}

it("captures only the actual baseline updater's released integrity envelope and preserves failure", () => {
  const f = fixture();
  write(path.join(f.root, "package.json"), {
    name: "openclaw",
    version: "2026.9.4",
    type: "module",
  });
  const entry = path.join(f.root, "openclaw.mjs");
  fs.writeFileSync(
    entry,
    `import fs from "node:fs";
const facts = {readerId: process.pid + ":1", timeOriginUnixMs: performance.timeOrigin,
  phase: "retained", budgetMs: 30000, secret: ${JSON.stringify(secret)},
  path: ${JSON.stringify(privateBody)}};
const records = [facts,
  {...facts, readerId: (process.pid + 1) + ":1"},
  {...facts, timeOriginUnixMs: facts.timeOriginUnixMs - 1}
].flatMap(identity => [
  {event: "reader-started"},
  {event: "reader-settled", outcome: "timed-out", elapsedMs: 30002, pendingIo: 1}
].map(event => ({0: JSON.stringify({subsystem: "update/package-integrity"}),
  1: {...identity, ...event}, 2: event.event, message: event.event,
  _meta: {logLevelName: "DEBUG", path: ${JSON.stringify(privateBody)}}})));
records.push({0: "{ordinary non-JSON log argument"});
fs.writeFileSync(${JSON.stringify(path.join(f.root, "openclaw-upgrade-survivor", "gateway.jsonl"))},
  records.map(record => JSON.stringify(record)).join("\\n") + "\\n");
process.exit(1);`,
  );
  const child = spawnSync(node, ["--import", observer, entry, "update"], {
    env: f.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(1);
  const report = capture(f);
  const expected = [
    { readerId: `${child.pid}:1`, event: "reader-started", phase: "retained", budgetMs: 30000 },
    {
      readerId: `${child.pid}:1`,
      event: "reader-settled",
      phase: "retained",
      budgetMs: 30000,
      outcome: "timed-out",
      elapsedMs: 30002,
      pendingIo: 1,
    },
  ];
  expect(report).toMatchObject({ phase: "update-candidate", outcome: "failed", exitStatus: 1 });
  expect(report.packageIntegrity).toEqual({ availability: "captured", observations: expected });
  const rawPath = path.join(f.artifacts, "diagnostics/raw.json");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  expect(fs.readFileSync(rawPath, "utf8")).not.toContain(privateBody);
  raw.packageIntegrity.observations[0].message = privateBody;
  raw.packageIntegrity.observations[0].secret = secret;
  write(rawPath, raw);
  const reprojected = path.join(f.root, "reprojected");
  publishDiagnostics(f.artifacts, reprojected, redactSensitiveText);
  const text = fs.readFileSync(path.join(reprojected, "failure.json"), "utf8");
  expect(text).not.toContain(privateBody);
  expect(text).not.toContain(secret);
  expect(JSON.parse(text).packageIntegrity.observations).toEqual(expected);
  raw.packageIntegrity.observations[0].budgetMs = "30000";
  write(rawPath, raw);
  const invalid = path.join(f.root, "invalid");
  publishDiagnostics(f.artifacts, invalid, redactSensitiveText);
  expect(JSON.parse(fs.readFileSync(path.join(invalid, "failure.json"), "utf8"))).toMatchObject({
    exitStatus: 1,
    packageIntegrity: { availability: "unavailable" },
    omissions: { "package integrity": "invalid observation; omitted" },
  });
});

it.each([
  { name: "different PID", identity: { pid: 43 } },
  { name: "different process origin", identity: { timeOriginUnixMs: 101 } },
  { name: "Doctor", identity: { role: "doctor" } },
  { name: "post-core", identity: { role: "post-core" } },
  { name: "different package", identity: { packageVersion: "2026.9.5" } },
  { name: "non-numeric budget", telemetry: { budgetMs: "30000" } },
  { name: "missing settled outcome", telemetry: { outcome: undefined } },
  { name: "negative pending I/O", telemetry: { pendingIo: -1 } },
])("omits integrity evidence from $name", ({ identity, telemetry }) => {
  const f = fixture();
  write(path.join(f.artifacts, "diagnostics/process-42-started.json"), {
    event: "started",
    role: "update",
    packageVersion: "2026.9.4",
    pid: 42,
    parentPid: 1,
    timeOriginUnixMs: 100,
    ...identity,
  });
  integrityLog(f, {
    readerId: "42:1",
    timeOriginUnixMs: 100,
    event: "reader-settled",
    phase: "retained",
    budgetMs: 30000,
    elapsedMs: 30002,
    outcome: "timed-out",
    pendingIo: 0,
    ...telemetry,
  });
  const report = capture(f);
  expect(report.exitStatus).toBe(1);
  expect(report.packageIntegrity).toEqual({ availability: "unavailable" });
  expect(report.omissions["package integrity"]).toBeTruthy();
});

it.each(["input", "output", "entries", "symlink", "directory-symlink", "malformed"] as const)(
  "omits the whole integrity diagnostic at the %s boundary",
  (boundary) => {
    const f = fixture();
    write(path.join(f.artifacts, "diagnostics/process-42-started.json"), {
      event: "started",
      role: "update",
      packageVersion: "2026.9.4",
      pid: 42,
      parentPid: 1,
      timeOriginUnixMs: 100,
    });
    integrityLog(f, {
      readerId: "42:1",
      timeOriginUnixMs: 100,
      event: "reader-settled",
      phase: "transaction",
      budgetMs: 30000,
      elapsedMs: 30002,
      outcome: "timed-out",
      pendingIo: 1,
    });
    const log = path.join(f.root, "openclaw-upgrade-survivor", "gateway.jsonl");
    const line = fs.readFileSync(log, "utf8");
    if (boundary === "symlink") {
      fs.renameSync(log, path.join(f.root, "outside.jsonl"));
      fs.symlinkSync(path.join(f.root, "outside.jsonl"), log);
    } else if (boundary === "directory-symlink") {
      const directory = path.dirname(log);
      fs.renameSync(directory, path.join(f.root, "outside-logs"));
      fs.symlinkSync(path.join(f.root, "outside-logs"), directory, "dir");
    } else {
      fs.writeFileSync(
        log,
        boundary === "input"
          ? "x".repeat(256 * 1024 + 1)
          : boundary === "malformed"
            ? line + "{"
            : line.repeat(boundary === "entries" ? 129 : 128),
      );
    }
    const report = capture(f);
    expect(report.exitStatus).toBe(1);
    expect(report.packageIntegrity).toEqual({ availability: "unavailable" });
    expect(report.omissions["package integrity"]).toBeTruthy();
  },
);

it("publishes bounded and redacted baseline Gateway, Cron run, and agent-turn failures", () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.artifacts, "missing-load-path"));
  for (const name of baselineGatewayLogs) {
    fs.writeFileSync(path.join(f.artifacts, name), `Baseline startup failed: token=${secret}\n`);
  }
  for (const name of cronCliLogs) {
    fs.writeFileSync(
      path.join(f.artifacts, name),
      `Published Cron run failed: token=${secret}\n` + "Cron run diagnostic line\n".repeat(1000),
    );
  }
  for (const stage of ["baseline", "candidate"]) {
    fs.writeFileSync(
      path.join(f.artifacts, `legacy-operator-${stage}-turn.err`),
      `Provider request failed during ${stage}: token=${secret}\n`,
    );
    fs.writeFileSync(
      path.join(f.artifacts, `legacy-operator-${stage}-turn.out`),
      `Agent ${stage} turn ended before completion: apiKey=${secret}\n`,
    );
  }
  const report = capture(f);
  for (const name of baselineGatewayLogs) {
    expect(report.logs[name]).toContain("Baseline startup failed");
  }
  for (const name of cronCliLogs) {
    expect(report.logs[name]).toContain("Published Cron run failed");
    expect(Buffer.byteLength(JSON.stringify(report.logs[name]))).toBeLessThanOrEqual(16 * 1024);
    expect(report.omissions[name]).toBe("redacted output truncated at a complete line (16 KiB)");
  }
  for (const stage of ["baseline", "candidate"]) {
    expect(report.logs[`legacy-operator-${stage}-turn.err`]).toContain(
      `Provider request failed during ${stage}`,
    );
    expect(report.logs[`legacy-operator-${stage}-turn.out`]).toContain(
      `Agent ${stage} turn ended before completion`,
    );
  }
});

it("retains failed rollback producer evidence without converting qualified omissions into restored files", () => {
  const f = fixture();
  write(path.join(f.artifacts, "backup-rollback-create.json"), {
    verified: true,
    skippedVolatileCount: 3,
    skipped: [],
    warning: `token=${secret}`,
  });
  write(path.join(f.artifacts, "backup-rollback-restore.json"), { ok: true });
  const proof = {
    status: "failed",
    runtime: {
      version: "2026.9.4",
      manifestSha256: "a".repeat(64),
      entrySha256: "b".repeat(64),
    },
    rawTranscriptRestoration: "unsupported-by-published-backup",
    omittedRawTranscripts: [
      {
        relative: "agents/main/sessions/upgrade-restored-index-history.jsonl",
        sha256: "c".repeat(64),
        canonicalEventCount: 2,
        reason: "published-2026.9.4-volatile-transcript",
      },
    ],
    failure: { command: "verify", message: "baseline preflight failed" },
  };
  write(path.join(f.artifacts, "backup-rollback.json"), proof);
  fs.writeFileSync(path.join(f.artifacts, "backup-rollback-restore.json.err"), `token=${secret}\n`);
  const report = capture(f);
  expect(report.outcome).toBe("failed");
  expect(JSON.parse(report.logs["backup-rollback-create.json"])).toMatchObject({
    verified: true,
    skippedVolatileCount: 3,
    skipped: [],
  });
  expect(JSON.parse(report.logs["backup-rollback-restore.json"])).toEqual({ ok: true });
  expect(JSON.parse(report.logs["backup-rollback.json"])).toEqual(proof);
  expect(report.logs["backup-rollback-restore.json.err"]).not.toContain(secret);
  expect(report.logs["backup-rollback-create.json.err"]).toBeNull();
  expect(report.omissions["backup-rollback-create.json.err"]).toBe("missing or unsafe file");
});

it.each([
  { name: "truncated Doctor output", opaqueCopies: 1, omission: "truncated at a complete line" },
  {
    name: "an oversized opaque plugin field",
    opaqueCopies: 8192,
    omission: "input exceeds cap; omitted whole",
  },
])("retains Doctor and plugin assertion failures with $name", ({ opaqueCopies, omission }) => {
  const f = fixture();
  write(path.join(f.root, "package.json"), {
    name: "openclaw",
    version: "2026.9.5",
    type: "module",
  });
  const entry = path.join(f.root, "openclaw.mjs");
  const uid = process.getuid?.();
  const doctorRoot = path.join(f.root, uid === undefined ? "openclaw" : `openclaw-${uid}`);
  fs.mkdirSync(doctorRoot, { mode: 0o700 });
  const resultPath = path.join(
    doctorRoot,
    `openclaw-update-doctor-${process.pid}-${randomUUID()}.json`,
  );
  const result = {
    status: "error",
    failureFacts: [{ check: "sessions", code: "step-refused", message: `token=${secret}` }],
    warnings: [`migration warning token=${secret}`],
    configChanges: [{ privateBody }],
    privateBody,
  };
  fs.writeFileSync(
    entry,
    `import fs from "node:fs"; fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH, ${JSON.stringify(JSON.stringify(result))}); process.exit(1);`,
  );
  const child = spawnSync(node, ["--import", observer, entry, "doctor"], {
    env: { ...f.env, OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(1);
  fs.unlinkSync(resultPath);
  const updateFile = path.join(f.artifacts, "update.json");
  fs.writeFileSync(
    updateFile,
    JSON.stringify(
      {
        status: "ok",
        after: { version: "2026.9.5" },
        steps: [
          { name: "openclaw doctor", exitCode: 0, stdoutTail: "Doctor output\n".repeat(3000) },
        ],
        postUpdate: {
          plugins: {
            status: "warning",
            changed: true,
            sync: {
              changed: true,
              switchedToBundled: [],
              switchedToNpm: [],
              warnings: [],
              errors: [`plugin sync failure token=${secret}`],
            },
            npm: {
              changed: true,
              outcomes: [
                {
                  pluginId: "discord",
                  status: "error",
                  code: "fixture-repair",
                  message: `token=${secret}`,
                },
                { pluginId: "discord", status: "updated", nextVersion: "2026.9.5" },
              ],
            },
            integrityDrifts: [{ pluginId: "discord", action: "kept", spec: `token=${secret}` }],
            privateBody: privateBody.repeat(opaqueCopies),
          },
        },
      },
      null,
      2,
    ),
  );
  const checked = spawnSync(
    node,
    [
      path.resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs"),
      "assert-successful-update-json",
      updateFile,
      "2026.9.5",
      f.artifacts,
    ],
    { env: f.env, encoding: "utf8", timeout: 10_000 },
  );
  expect(checked.status).toBe(1);
  expect(checked.stderr).toContain("successful update failed plugin convergence");
  const receipt = fs.readFileSync(
    path.join(f.artifacts, "diagnostics/successful-update-check.json"),
    "utf8",
  );
  expect(Buffer.byteLength(receipt)).toBeLessThan(256 * 1024);
  expect(receipt).not.toContain(privateBody);
  expect(JSON.parse(receipt)).toMatchObject({
    availability: "captured",
    outcome: "failed",
    plugins: { status: "warning" },
  });
  const report = capture(f);
  expect(report.omissions["update.json"]).toContain(omission);
  if (opaqueCopies > 1) {
    expect(report.logs["update.json"]).toBeNull();
  } else {
    expect(report.logs["update.json"]).not.toContain("postUpdate");
  }
  expect(report.successfulUpdateCheck).toMatchObject({
    availability: "captured",
    outcome: "failed",
    message: "successful update failed plugin convergence",
    plugins: {
      status: "warning",
      sync: { errors: [expect.stringContaining("plugin sync failure")] },
      npm: {
        outcomes: [
          { pluginId: "discord", status: "error", code: "fixture-repair" },
          { pluginId: "discord", status: "updated", nextVersion: "2026.9.5" },
        ],
      },
      integrityDrifts: [{ pluginId: "discord", action: "kept" }],
    },
  });
  expect(report.migration.doctor).toMatchObject({
    availability: "captured",
    processes: [
      {
        exitCode: 1,
        result: { status: "error", failureFacts: [{ check: "sessions", code: "step-refused" }] },
      },
    ],
  });
  expect(report.migration.doctor.processes[0].result.warnings).toHaveLength(1);
  expect(report.migration.doctor.processes[0].result).not.toHaveProperty("configChanges");
});

it("projects retained-import obligations and archive receipts without reading session bodies or migrating SQLite", () => {
  const f = fixture();
  const store = path.join(f.state, "agents/main/sessions/sessions.json");
  const transcript = path.join(f.state, "agents/main/sessions/retained.jsonl");
  const archive = path.join(f.state, "agents/main/session-sqlite-import-archive/retained.jsonl");
  write(store, { privateBody });
  fs.writeFileSync(transcript, privateBody);
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA user_version=20; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT);",
  );
  db.prepare("INSERT INTO migration_runs VALUES (?, ?, ?)").run(
    "deferred-plugin-migration:discord",
    "pending",
    JSON.stringify({
      pluginId: "discord",
      reason: `waiting token=${secret}`,
      command: privateBody,
      requiresStateMigration: true,
    }),
  );
  db.prepare("INSERT INTO migration_sources VALUES (?, ?, ?, ?, ?, ?)").run(
    "deferred-plugin-session-import",
    store,
    hash(store),
    "completed",
    0,
    JSON.stringify({
      pluginIds: ["discord"],
      databaseIdentity: privateBody,
      sources: [{ path: transcript, identity: { sha256: hash(transcript) } }],
      privateBody,
    }),
  );
  db.close();
  const before = hash(dbPath);
  write(path.join(f.state, "session-sqlite-migration-runs/run.json"), {
    runId: "synthetic-run",
    completedAt: "2026-09-15T00:00:00.000Z",
    targets: [
      {
        agentId: "main",
        storePath: store,
        sqlitePath: path.join(f.state, "agents/main/agent/openclaw-agent.sqlite"),
        validationBeforeArchive: "passed",
        plannedMoves: [{ kind: "transcript", sourcePath: transcript, archivePath: archive }],
        completedMoves: [],
        issues: [
          {
            code: "plugin_migration_source_retained",
            message: `waiting token=${secret}`,
            sessionKey: privateBody,
          },
        ],
      },
    ],
    privateBody,
  });
  const report = capture(f);
  expect(report.migration.sessions).toMatchObject({
    availability: "captured",
    deferred: [{ status: "pending", pluginId: "discord" }],
    imports: [
      {
        status: "completed",
        removedSource: false,
        pluginIds: ["discord"],
        sources: [{ path: transcript, sha256: hash(transcript) }],
      },
    ],
  });
  expect(report.migration.archives).toMatchObject({
    availability: "captured",
    runs: [
      { targets: [{ plannedMoveCount: 1, completedMoves: [], validationBeforeArchive: "passed" }] },
    ],
  });
  expect(hash(dbPath)).toBe(before);
  expect(fs.readFileSync(transcript, "utf8")).toBe(privateBody);
});

it("retains the custom fixture's actual Doctor module and callback identities without argv contents", () => {
  const f = fixture();
  const seeded = spawnSync(node, [sibling, "seed"], {
    env: f.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(seeded.status, seeded.stderr).toBe(0);
  const doctor = path.join(f.root, "custom-plugins/memory/doctor-contract-api.mjs");
  const invoked = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(doctor).href)}); m.normalizeCompatibilityConfig({cfg:{}});`,
      privateBody,
    ],
    { env: f.env, encoding: "utf8", timeout: 10_000 },
  );
  expect(invoked.status, invoked.stderr).toBe(0);
  const report = capture(f);
  expect(report.migration.sibling).toMatchObject({
    availability: "captured",
    registrations: [
      { surface: "doctor-module", sourceSha256: hash(doctor), updateCanary: false },
      { surface: "doctor-contract", sourceSha256: hash(doctor), updateCanary: false },
    ],
  });
  expect(report.migration.sibling.registrations[0]).not.toHaveProperty("argv");
  expect(report.migration.sibling.registrations[0]).not.toHaveProperty("value");
});

it("omits unsafe migration files and oversized registration collections without treating missing evidence as success", () => {
  const f = fixture();
  const outside = path.join(f.root, "outside");
  fs.writeFileSync(outside, privateBody);
  fs.symlinkSync(outside, path.join(f.state, "state/openclaw.sqlite"));
  fs.symlinkSync(f.root, path.join(f.state, "session-sqlite-migration-runs"));
  fs.writeFileSync(path.join(f.root, "baseline-gateway.log"), privateBody);
  fs.symlinkSync(f.root, path.join(f.artifacts, "missing-load-path"));
  fs.symlinkSync(outside, path.join(f.artifacts, "backup-rollback-create.json"));
  fs.writeFileSync(path.join(f.artifacts, "backup-rollback.json"), "x".repeat(262145));
  fs.writeFileSync(
    path.join(f.artifacts, "sibling-registrations.jsonl"),
    Array.from({ length: 129 }, () =>
      JSON.stringify({
        surface: "runtime",
        stateDir: f.state,
        source: "file:///fixture",
        sharedSource: "file:///fixture",
        argv: [],
      }),
    ).join("\n"),
  );
  const report = capture(f);
  expect(report.logs["backup-rollback-create.json"]).toBeNull();
  expect(report.omissions["backup-rollback-create.json"]).toBe("missing or unsafe file");
  expect(report.logs["backup-rollback.json"]).toBeNull();
  expect(report.omissions["backup-rollback.json"]).toBe("input exceeds cap; omitted whole");
  for (const section of ["sessions", "archives", "sibling", "doctor"]) {
    expect(report.migration[section].availability).toBe("unavailable");
  }
  for (const name of baselineGatewayLogs) {
    expect(report.logs[name]).toBeNull();
    expect(report.omissions[name]).toBe("missing or unsafe file");
  }
  expect(report.limits).toMatchObject({
    inputBytesPerFile: 262144,
    outputBytesPerLog: 16384,
    reportBytes: 524288,
    entriesPerCollection: 128,
  });
});

it("does not reuse sibling or startup observations when an attempt fails before fixture seeding", () => {
  const f = fixture();
  const turnLogs = ["baseline", "candidate"].flatMap((stage) =>
    ["out", "err"].map((extension) => `legacy-operator-${stage}-turn.${extension}`),
  );
  const logs = [
    ...turnLogs,
    ...cronCliLogs,
    ...baselineGatewayLogs,
    "sibling-refusal-update.json",
    "sibling-refusal-status.json",
    "sibling-refusal-worker.json",
    "sibling-refusal-child.json",
    "sibling-refusal-cleanup.json",
    "legacy-operator-restored-index.json",
    "restored-index-post-update.json",
    "restored-index-candidate-import.json",
    "restored-index-rollback.json",
    "backup-rollback.json",
    "backup-rollback-create.json",
    "backup-rollback-create.json.err",
    "backup-rollback-restore.json",
    "backup-rollback-restore.json.err",
  ];
  for (const name of logs) {
    fs.mkdirSync(path.dirname(path.join(f.artifacts, name)), { recursive: true });
    fs.writeFileSync(path.join(f.artifacts, name), "previous attempt failure");
  }
  fs.writeFileSync(
    path.join(f.artifacts, "sibling-registrations.jsonl"),
    JSON.stringify({
      surface: "doctor-contract",
      stateDir: f.state,
      source: "file:///previous-attempt",
      sharedSource: "file:///previous-attempt",
      argv: [],
      sourceSha256: "a".repeat(64),
    }) + "\n",
  );
  const unsafeArtifacts = path.join(f.root, "unsafe-artifacts");
  const outsideLogs = path.join(f.root, "outside-logs");
  fs.mkdirSync(unsafeArtifacts);
  fs.mkdirSync(outsideLogs);
  fs.symlinkSync(outsideLogs, path.join(unsafeArtifacts, "missing-load-path"));
  for (const name of baselineGatewayLogs) {
    fs.writeFileSync(path.join(outsideLogs, path.basename(name)), "outside capture ownership");
  }
  const prepared = spawnSync(
    "bash",
    [
      "-c",
      [
        'source "$1"',
        "prepare_diagnostics_capture",
        'printf "owned-ready:%s\n" "${diagnostics_ready:-0}"',
        'ARTIFACT_DIR="$2"',
        "diagnostics_ready=0",
        "prepare_diagnostics_capture",
        'printf "symlink-ready:%s\n" "$diagnostics_ready"',
      ].join("; "),
      "capture-test",
      path.resolve("scripts/lib/upgrade-survivor-diagnostics.sh"),
      unsafeArtifacts,
    ],
    {
      env: { ...f.env, ARTIFACT_DIR: f.artifacts },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  for (const name of baselineGatewayLogs) {
    expect(fs.readFileSync(path.join(outsideLogs, path.basename(name)), "utf8")).toBe(
      "outside capture ownership",
    );
  }
  expect(prepared.stdout).toBe("owned-ready:1\nsymlink-ready:0\n");
  expect(prepared.stderr).toContain("private capture setup failed");
  const report = capture(f);
  expect(report.migration.sibling.availability).toBe("unavailable");
  for (const name of logs) {
    expect(report.logs[name]).toBeNull();
  }
});

it("does not create missing WAL sidecars through either receipt or plugin-index capture", () => {
  const f = fixture();
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT);",
  );
  database.close();
  expect(fs.readFileSync(dbPath)[18]).toBe(2);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(dbPath + suffix)).toBe(false);
  }
  const before = hash(dbPath);
  const report = capture(f);
  expect(report.migration.sessions.availability).toBe("unavailable");
  expect(report.pluginIdentity.availability).toBe("unknown");
  expect(hash(dbPath)).toBe(before);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(dbPath + suffix), suffix).toBe(false);
  }
});

it("keeps the existing complete WAL family unchanged after observation closes", () => {
  const f = fixture();
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT); PRAGMA wal_checkpoint(FULL);",
    );
    const files = [dbPath, dbPath + "-wal", dbPath + "-shm"];
    const before = files.map(hash);
    const report = capture(f);
    expect(report.migration.sessions.availability).toBe("unavailable");
    expect(report.omissions["migration-sessions"]).toContain("omitted before native open");
    expect(files.map(hash)).toEqual(before);
    expect(fs.existsSync(dbPath + "-journal")).toBe(false);
  } finally {
    database.close();
  }
});
