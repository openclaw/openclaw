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
