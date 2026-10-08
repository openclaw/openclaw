import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("publishes bounded redacted progress evidence after failure and success", () => {
  const root = dirs.make("repair-progress-publication-");
  const artifacts = path.join(root, "artifacts");
  const state = path.join(root, "state");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(state);
  const write = (name: string, text: string) => {
    const file = path.join(artifacts, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const secret = "progress-fixture-private-token";
  const evidence = { beforeSettlement: true, operation: "sqlite-integrity" };
  write("progress-repair.stdout", JSON.stringify({ status: "ok" }));
  write(
    "progress-repair.stderr",
    `Authorization: Bearer ${secret}\n${"bounded progress line\n".repeat(1500)}`,
  );
  write(
    "progress-repair-exit.json",
    JSON.stringify({ exitCode: 124, processTreeState: "terminated" }),
  );
  write("phase.txt", "progress-repair\n");
  for (const phase of [
    "service-probe-install",
    "service-probe-reload",
    "service-probe-verify",
    "service-probe-restore",
    "service-probe-restore-reload",
    "service-probe-restore-verify",
  ]) {
    write(phase + ".stdout", JSON.stringify({ sha256: "a".repeat(64) }));
    write(phase + "-exit.json", JSON.stringify({ exitCode: 0 }));
  }
  write("progress-cell.json", JSON.stringify({ phase: "progress-repair", exitStatus: 124 }));
  for (const name of ["held", "released", "observed", "heartbeat", "result"]) {
    write(`progress-repair/${name}.json`, JSON.stringify(evidence));
  }
  write("progress-repair/fixture.json", JSON.stringify({ privatePackageInventory: true }));
  write("incognito-before.stdout", "PRIVATE_CHAT_FIXTURE");
  write("durable-after.stdout", "PRIVATE_CHAT_FIXTURE");
  write(
    "summary.json",
    JSON.stringify({
      status: "passed",
      baseline: { spec: "openclaw@2026.9.7", version: "2026.9.7" },
      candidate: { kind: "tarball", version: "2026.10.1" },
      scenario: "repair-progress",
      installedVersion: "2026.10.2-first-hop.0",
      candidateInstallMode: "npm",
      updateRestartMode: "manual",
      updateOutcome: "success",
      phases: [],
    }),
  );
  const captured = spawnSync(
    resolveTestNodeExecPath(),
    [
      path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs"),
      "capture",
      artifacts,
      "progress-repair",
      "124",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(captured.status, captured.stderr).toBe(0);
  for (const outcome of ["failed", "passed"] as const) {
    const destination = path.join(root, outcome);
    publishDiagnostics(artifacts, destination, redactSensitiveText, outcome);
    const text = fs.readFileSync(
      path.join(destination, outcome === "passed" ? "summary.json" : "failure.json"),
      "utf8",
    );
    const report = JSON.parse(text);
    expect(report.logs["progress-repair.stdout"]).toContain('"status":"ok"');
    expect(report.logs["progress-repair.stderr"]).toContain("bounded progress line");
    expect(
      Buffer.byteLength(JSON.stringify(report.logs["progress-repair.stderr"])),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(report.omissions["progress-repair.stderr"]).toContain("truncated");
    expect(JSON.parse(report.logs["progress-repair-exit.json"]).exitCode).toBe(124);
    expect(report.logs["phase.txt"]).toBe("progress-repair\n");
    for (const phase of [
      "service-probe-install",
      "service-probe-reload",
      "service-probe-verify",
      "service-probe-restore",
      "service-probe-restore-reload",
      "service-probe-restore-verify",
    ]) {
      expect(JSON.parse(report.logs[phase + ".stdout"]).sha256).toBe("a".repeat(64));
      expect(JSON.parse(report.logs[phase + "-exit.json"]).exitCode).toBe(0);
    }
    for (const name of ["held", "released", "observed", "heartbeat", "result"]) {
      expect(JSON.parse(report.logs[`progress-repair/${name}.json`])).toEqual(evidence);
    }
    expect(text).not.toContain(secret);
    expect(text).not.toContain("privatePackageInventory");
    expect(text).not.toContain("PRIVATE_CHAT_FIXTURE");
    if (outcome === "failed") {
      expect(report.exitStatus).toBe(124);
    }
  }
});
