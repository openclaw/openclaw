import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as retention from "../infra/doctor-capture-retention.js";
import * as ancestry from "../infra/restart-stale-pids.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import * as databaseBackup from "../infra/update-database-backup.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import * as baselineCapture from "../infra/update-recovery-baseline-capture.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import * as preparation from "../plugins/doctor-contract-preparation.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const captureRef = (directory: string) => ({
  directory,
  manifestPath: path.join(directory, "manifest.json"),
  manifestSha256: "0".repeat(64),
});
const captured = (directory: string) => ({
  ref: captureRef(directory),
  warnings: [],
  diagnostics: { databaseWarnings: [] },
});
const captureDefaults = () => ({
  root: process.cwd(),
  signal: new AbortController().signal,
  assertCurrent() {},
});

it("removes its failed unsealed capture after the backup work settles", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const originalConfig = fs.readFileSync(state.configPath);
    vi.spyOn(preparation, "preparePluginDoctorMigrationBackupResources").mockResolvedValue({
      resources: [],
      deferredPluginIds: new Set(),
      notices: [],
      assertCurrent() {},
    });
    let attempt = "";
    vi.spyOn(databaseBackup, "createUpdateDatabaseBackup").mockImplementationOnce(
      async ({ backupRoot }) => {
        attempt = path.dirname(backupRoot);
        fs.writeFileSync(path.join(attempt, "payload", "unfinished"), "private original bytes");
        throw new Error("capture interrupted");
      },
    );

    const result = await preserveDoctorOriginalState({ ...captureDefaults(), env: state.env });

    expect(attempt).not.toBe("");
    expect(fs.existsSync(attempt)).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ checkId: "core/doctor/recovery-capture", severity: "warning" }),
    );
    expect(fs.readFileSync(state.configPath)).toEqual(originalConfig);
  });
});

it("retains an original capture that completes after the former ten-minute deadline", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(retention, "retireExpiredStandaloneDoctorCaptures").mockResolvedValue({
      retired: [],
      warnings: [],
    });
    const capture = vi
      .spyOn(baselineCapture, "captureUpdateRecoveryBaseline")
      .mockImplementation(async ({ assertCurrent, signal }) => {
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        elapsed = 15 * 60_000;
        assertCurrent();
        signal?.throwIfAborted();
        return captured(state.stateDir);
      });
    const result = await preserveDoctorOriginalState({ ...captureDefaults(), env: state.env });
    expect(capture).toHaveBeenCalledOnce();
    expect(result).toEqual({ findings: [], warnings: [] });
  });
});

it.each(["admission", "worker"] as const)(
  "bounds %s capture work and reports recovery advice",
  async (work) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let elapsed = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      vi.spyOn(baselineCapture, "captureUpdateRecoveryBaseline").mockImplementation(
        async ({ assertCurrent, signal }) => {
          if (work === "admission") {
            elapsed = 20 * 60_000;
            assertCurrent();
          } else {
            await vi.advanceTimersByTimeAsync(20 * 60_000);
          }
          signal?.throwIfAborted();
          return captured(state.stateDir);
        },
      );
      const result = await preserveDoctorOriginalState({ ...captureDefaults(), env: state.env });
      expect(result.warnings.join("\n")).toContain("timed out after 1200 s");
      expect(result.warnings.join("\n")).toContain("verified backup");
      expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
    });
  },
);

it.each(["ancestry-unverified", "missing-capture"] as const)(
  "preserves the original capture refusal classification for %s",
  async (failure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const driver = readUpdateRunDriver();
      expect(driver).toBeDefined();
      const run = createUpdateRun({ trigger: "cli", origin: { driver } });
      vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
        complete: failure !== "ancestry-unverified",
        pids: new Set([process.pid]),
      });
      const directory = state.path("missing-original-capture");
      const refusal = await preserveDoctorOriginalState({
        ...captureDefaults(),
        env: state.env,
        writeAuthority: {
          inputHash: "0".repeat(64),
          assertCurrent() {},
          originalRecoveryCapture: {
            runId: run.runId,
            installRoot: process.cwd(),
            ref: captureRef(directory),
          },
        },
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
      if (failure === "ancestry-unverified") {
        expect(refusal).toHaveProperty("failureFacts.0.code", failure);
      }
      expect(refusal).toMatchObject({
        refusal:
          failure === "ancestry-unverified"
            ? { kind: "deferred", reason: "admission-unavailable" }
            : { kind: "data-at-risk", reason: "unreadable-state" },
        message: expect.stringContaining(
          failure === "ancestry-unverified"
            ? "openclaw update repair"
            : "The admitted original update capture is unavailable",
        ),
      });
    });
  },
);

it("keeps failed unsealed update evidence without warning or taking another capture", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const driver = readUpdateRunDriver();
    expect(driver).toBeDefined();
    const run = createUpdateRun({ trigger: "cli", origin: { driver } });
    vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
      complete: true,
      pids: new Set([process.pid]),
    });
    const directory = path.join(
      resolveUpdateCaptureRoot(fs.realpathSync(state.stateDir)),
      run.runId,
    );
    fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".openclaw-private-update-capture"), "failed capture");
    fs.writeFileSync(path.join(directory, "payload", "0"), "original bytes");
    const capture = vi.spyOn(baselineCapture, "captureUpdateRecoveryBaseline");

    const result = await preserveDoctorOriginalState({
      ...captureDefaults(),
      env: { ...state.env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      writeAuthority: {
        inputHash: "0".repeat(64),
        assertCurrent() {},
        originalRecoveryCapture: { runId: run.runId, installRoot: process.cwd() },
      },
    });

    expect(result.findings).not.toContainEqual(
      expect.objectContaining({ checkId: "core/doctor/recovery-capture" }),
    );
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.existsSync(path.join(directory, "payload", "0"))).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });
});
