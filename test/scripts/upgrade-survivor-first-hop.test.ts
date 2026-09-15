import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observer = resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

function rollbackSuccessSummary() {
  const hash = "a".repeat(64);
  return {
    status: "passed",
    baseline: { spec: "openclaw@2026.9.4", version: "2026.9.4" },
    candidate: { kind: "tarball", version: "2026.9.5" },
    scenario: "legacy-operator-state",
    installedVersion: "2026.9.5",
    candidateInstallMode: "updater",
    updateRestartMode: "manual",
    updateOutcome: "success",
    phases: [],
    backupRollback: {
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      runtime: {
        version: "2026.9.4",
        schemaVersions: { state: 16, agent: 19 },
        packageRoot: "/private/host/runtime",
        entry: "/private/host/index.mjs",
        manifestSha256: hash,
        entrySha256: hash,
      },
      candidateSchemaVersions: { state: 17, agent: 21 },
      archive: { path: "/private/host/archive.tgz", sha256: hash },
      restoredStateDir: "/private/host/restored",
      before: {
        databases: [
          {
            kind: "state",
            present: true,
            relative: "/private/host/state",
            userVersion: 16,
            contentVersion: 16,
            sessions: [],
            tables: [],
          },
          {
            kind: "agent",
            agentId: "main",
            present: true,
            userVersion: 19,
            contentVersion: 19,
            relative: "/private/host/agent",
            metadata: { secret: "PRIVATE_VALUE" },
            sessions: [{ key: "PRIVATE_SESSION_KEY", sessionId: "PRIVATE_SESSION_ID" }],
            tables: [
              { table: "session_nodes", rows: 1, sha256: hash, columns: ["PRIVATE_COLUMN"] },
              { table: "transcript_events", rows: 2, sha256: hash, raw: "PRIVATE_TRANSCRIPT" },
            ],
          },
          { kind: "agent", agentId: "ops", present: false, relative: "/private/host/ops" },
        ],
        files: [
          {
            kind: "legacy-store",
            relative: "/private/host/legacy",
            sha256: hash,
            raw: "PRIVATE_JSON",
          },
        ],
      },
      preflights: [
        {
          agentId: "main",
          status: "exact",
          foundVersion: 19,
          targetVersion: 19,
          output: "/private/host/preflight.json",
        },
      ],
      sessionReads: [
        {
          agentId: "main",
          count: 1,
          output: "/private/host/sessions.json",
          path: "/private/host/agent.sqlite",
        },
      ],
    },
  };
}

async function publishSuccess(summary: unknown) {
  const root = tempDirs.make("survivor-rollback-publication-");
  const artifacts = join(root, "private");
  const published = join(root, "published");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "summary.json"), JSON.stringify(summary));
  const { publishDiagnostics } = await import(observer);
  return {
    published,
    publish: () => publishDiagnostics(artifacts, published, (text: string) => text, "passed"),
  };
}

describe("upgrade survivor rollback publication", () => {
  it("publishes the validated rollback schema, session counts and hashes without private state", async () => {
    const { publish, published } = await publishSuccess(rollbackSuccessSummary());
    publish();
    const text = readFileSync(join(published, "summary.json"), "utf8");
    expect(text).not.toMatch(/PRIVATE_|\/private\/host/);
    const proof = JSON.parse(text).backupRollback;
    expect(proof).toMatchObject({
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      baselineSchemaVersions: { state: 16, agent: 19 },
      candidateSchemaVersions: { state: 17, agent: 21 },
      archiveSha256: "a".repeat(64),
      baselineRuntime: { manifestSha256: "a".repeat(64), entrySha256: "a".repeat(64) },
      databases: [
        {
          kind: "state",
          present: true,
          userVersion: 16,
          contentVersion: 16,
          sessionCount: 0,
          tables: [],
        },
        {
          kind: "agent",
          agentId: "main",
          present: true,
          userVersion: 19,
          contentVersion: 19,
          sessionCount: 1,
          tables: [
            { table: "session_nodes", rows: 1, sha256: "a".repeat(64) },
            { table: "transcript_events", rows: 2, sha256: "a".repeat(64) },
          ],
          preflight: { status: "exact", foundVersion: 19, targetVersion: 19 },
          sessionRead: { count: 1 },
        },
        { kind: "agent", agentId: "ops", present: false },
      ],
      files: [{ kind: "legacy-store", sha256: "a".repeat(64) }],
    });
    expect(readdirSync(published)).toEqual(["summary.json"]);
  });

  it.each(["absent", "older-legacy-absent", "not-applicable"])(
    "preserves %s rollback evidence from older scenarios",
    async (kind) => {
      const summary = rollbackSuccessSummary();
      const { publish, published } = await publishSuccess({
        ...summary,
        scenario: kind === "absent" ? "base" : "legacy-operator-state",
        baseline: { spec: "openclaw@2026.9.3", version: "2026.9.3" },
        backupRollback:
          kind === "not-applicable"
            ? {
                status: "not-applicable",
                baselineVersion: "2026.9.3",
                minimumBaseline: "2026.9.4",
                reason: "/private/host/PRIVATE_REASON",
              }
            : undefined,
      });
      publish();
      const receipt = JSON.parse(readFileSync(join(published, "summary.json"), "utf8"));
      expect(receipt.backupRollback).toEqual(
        kind === "not-applicable"
          ? {
              status: "not-applicable",
              baselineVersion: "2026.9.3",
              minimumBaseline: "2026.9.4",
            }
          : undefined,
      );
    },
  );

  it.each([
    { kind: "missing", value: undefined },
    { kind: "null", value: null },
  ])("rejects $kind required rollback evidence before publishing success", async ({ value }) => {
    const { publish, published } = await publishSuccess({
      ...rollbackSuccessSummary(),
      backupRollback: value,
    });
    expect(publish).toThrow("Invalid backup rollback evidence");
    expect(existsSync(join(published, "summary.json"))).toBe(false);
  });

  it.each([
    "unfinished",
    "wrong-candidate",
    "missing-preflight",
    "duplicate-read",
    "wrong-count",
    "wrong-schema",
    "invalid-hash",
    "unsafe-table-name",
    "oversized-collection",
    "no-history",
  ])("refuses %s rollback evidence without writing a successful receipt", async (kind) => {
    const summary = rollbackSuccessSummary();
    const proof = summary.backupRollback;
    if (kind === "unfinished") proof.status = "captured";
    if (kind === "wrong-candidate") proof.candidateVersion = "2026.9.6";
    if (kind === "missing-preflight") proof.preflights = [];
    if (kind === "duplicate-read") proof.sessionReads.push(proof.sessionReads[0]!);
    if (kind === "wrong-count") proof.sessionReads[0]!.count = 2;
    if (kind === "wrong-schema") proof.preflights[0]!.targetVersion = 21;
    if (kind === "invalid-hash") proof.archive.sha256 = "PRIVATE_HASH";
    if (kind === "unsafe-table-name")
      proof.before.databases[1]!.tables![0]!.table = "/private/host/table";
    if (kind === "oversized-collection")
      proof.before.files = Array.from({ length: 129 }, () => proof.before.files[0]!);
    if (kind === "no-history") proof.before.databases[1]!.tables![1]!.rows = 0;
    const { publish, published } = await publishSuccess(summary);
    expect(publish).toThrow();
    expect(existsSync(join(published, "summary.json"))).toBe(false);
  });
});

describe("upgrade survivor first-hop process evidence", () => {
  it.each([0, 1])("retains first-hop identities and Doctor IPC on exit %i", async (code) => {
    const root = realpathSync(tempDirs.make("survivor-first-hop-"));
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const tmp = join(root, "tmp");
    const ipcRoot = join(tmp, `openclaw${process.getuid ? `-${process.getuid()}` : ""}`);
    mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
    const ipc = join(
      ipcRoot,
      "openclaw-update-doctor-123-00000000-0000-4000-8000-000000000000.json",
    );
    const manifest = join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    const entrypoint = join(root, "openclaw.mjs");
    // Files change under the running parent. Reading package.json at exit would
    // falsely attribute that parent's result to the newly installed updater.
    writeFileSync(
      entrypoint,
      `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === 'update') {
  fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({name:'openclaw',version:'2026.8.1'}));
  const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(observer)}, process.argv[1], 'doctor', '--non-interactive', '--fix'], {
    env: {...process.env, OPENCLAW_UPDATE_IN_PROGRESS:'1', OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH:${JSON.stringify(ipc)}}, stdio:'inherit'
  });
  fs.unlinkSync(${JSON.stringify(ipc)});
  process.exitCode = child.status;
} else {
  fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH, JSON.stringify({
    status: ${JSON.stringify(code === 0 ? "ok" : "error")},
    failureFacts: [{check:'plugin-doctor-post-session-state',code:'blocked-by-session-repair-failure',message:'private-doctor-value', extra:'private-ignored-value'}],
    configHash:'private-config-value'
  }), {mode:0o600});
  console.log('doctor fixture finished');
  process.exitCode = ${code};
}
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", observer, entrypoint, "update", "--tag", "private-argument-value"],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
          OPENCLAW_GATEWAY_TOKEN: "private-environment-value",
          TMPDIR: tmp,
          TEMP: tmp,
          TMP: tmp,
        },
      },
    );
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout).toBe("doctor fixture finished\n");
    expect(result.stderr).toBe("");
    const files = readdirSync(join(artifacts, "diagnostics"));
    const reports = files.map((name) =>
      JSON.parse(readFileSync(join(artifacts, "diagnostics", name), "utf8")),
    );
    const started = reports.filter((report) => report.event === "started");
    const parent = started.find((report) => report.role === "update");
    const doctor = started.find((report) => report.role === "doctor");
    expect(started).toHaveLength(2);
    expect(parent).toMatchObject({ packageVersion: "2026.7.1-2" });
    expect(doctor).toMatchObject({ packageVersion: "2026.8.1", parentPid: parent.pid });
    expect(reports.filter((report) => report.event === "exited")).toEqual(
      expect.arrayContaining([
        { ...parent, event: "exited", exitCode: code },
        expect.objectContaining({ ...doctor, event: "exited", exitCode: code }),
      ]),
    );
    expect(existsSync(ipc)).toBe(false);
    const doctorExit = reports.find(
      (report) => report.role === "doctor" && report.event === "exited",
    );
    expect(doctorExit.doctorResult).toEqual({
      status: code === 0 ? "ok" : "error",
      failureFacts: [
        {
          check: "plugin-doctor-post-session-state",
          code: "blocked-by-session-repair-failure",
          message: "private-doctor-value",
        },
      ],
    });
    const capture = spawnSync(
      process.execPath,
      [observer, "capture", artifacts, "update-candidate", String(code), "", artifacts],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: join(root, "missing-config.json"),
        },
      },
    );
    expect(capture.status, capture.stderr).toBe(0);
    const { publishDiagnostics } = await import(observer);
    const published = join(root, "published");
    publishDiagnostics(artifacts, published, (text: string) =>
      text.replaceAll("private-doctor-value", "[REDACTED]"),
    );
    const report = JSON.parse(readFileSync(join(published, "failure.json"), "utf8"));
    expect(report.doctorResults).toEqual({
      availability: "captured",
      observations: [
        {
          pid: doctor.pid,
          parentPid: parent.pid,
          packageVersion: "2026.8.1",
          exitCode: code,
          status: code === 0 ? "ok" : "error",
          failureFacts: [
            {
              check: "plugin-doctor-post-session-state",
              code: "blocked-by-session-repair-failure",
              message: "[REDACTED]",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-doctor-value|private-ignored-value|private-config-value/,
    );
    const rawPath = join(artifacts, "diagnostics/raw.json");
    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    raw.doctorResults[0].exited.parentPid++;
    writeFileSync(rawPath, JSON.stringify(raw));
    const mismatched = join(root, "mismatched");
    publishDiagnostics(artifacts, mismatched, (text: string) => text);
    expect(
      JSON.parse(readFileSync(join(mismatched, "failure.json"), "utf8")).doctorResults,
    ).toEqual({ availability: "unknown", observations: [] });
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("private-argument-value");
    expect(serialized).not.toContain("private-environment-value");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/private-ignored-value|private-config-value/);
  });

  it.each([
    "outside",
    "wrong-name",
    "malformed",
    "oversized",
    ...(process.platform === "win32" ? [] : ["symlink"]),
  ])("preserves Doctor exit when its IPC is %s", (kind) => {
    const root = realpathSync(tempDirs.make("survivor-unavailable-doctor-"));
    const tmp = join(root, "tmp");
    const ipcRoot = join(tmp, `openclaw${process.getuid ? `-${process.getuid()}` : ""}`);
    mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
    );
    const entrypoint = join(root, "openclaw.mjs");
    writeFileSync(entrypoint, "process.exitCode = 7;");
    const ipcFilename = "openclaw-update-doctor-123-00000000-0000-4000-8000-000000000000.json";
    const ipc =
      kind === "outside"
        ? join(root, ipcFilename)
        : join(ipcRoot, kind === "wrong-name" ? "other.json" : ipcFilename);
    const payload =
      kind === "malformed"
        ? "{"
        : JSON.stringify({
            status: "error",
            failureFacts: Array.from({ length: kind === "oversized" ? 6 : 1 }, () => ({
              check: "doctor",
              code: "failure",
              message: "private-doctor-value",
            })),
          });
    const target = kind === "symlink" ? join(root, "original.json") : ipc;
    writeFileSync(target, payload, { mode: 0o600 });
    if (kind === "symlink") {
      symlinkSync(target, ipc);
    }
    const result = spawnSync(process.execPath, ["--import", observer, entrypoint, "doctor"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: ipc,
      },
    });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout + result.stderr).toBe("");
    expect(readFileSync(target, "utf8")).toBe(payload);
    const reports = readdirSync(join(root, "diagnostics")).map((name) =>
      JSON.parse(readFileSync(join(root, "diagnostics", name), "utf8")),
    );
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.event === "exited")).toEqual({
      ...reports.find((report) => report.event === "started"),
      event: "exited",
      exitCode: 7,
    });
    expect(JSON.stringify(reports)).not.toContain("private-doctor-value");
  });

  it.skipIf(process.platform === "win32")("does not turn a signal into a successful exit", () => {
    const root = realpathSync(tempDirs.make("survivor-interrupted-hop-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }),
    );
    const entrypoint = join(root, "openclaw.mjs");
    writeFileSync(entrypoint, 'process.kill(process.pid, "SIGTERM");');
    const result = spawnSync(process.execPath, ["--import", observer, entrypoint, "update"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root },
    });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout + result.stderr).toBe("");
    const reports = readdirSync(join(root, "diagnostics")).map((name) =>
      JSON.parse(readFileSync(join(root, "diagnostics", name), "utf8")),
    );
    expect(reports).toEqual([
      expect.objectContaining({ role: "update", event: "started", packageVersion: "2026.7.1-2" }),
    ]);
  });
});
