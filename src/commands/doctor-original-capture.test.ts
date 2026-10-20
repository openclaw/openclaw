import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as retention from "../infra/doctor-capture-retention.js";
import * as ancestry from "../infra/restart-stale-pids.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import * as baselineCapture from "../infra/update-recovery-baseline-capture.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";

afterEach(() => vi.restoreAllMocks());

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
        root: process.cwd(),
        env: state.env,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        signal: new AbortController().signal,
        assertCurrent() {},
        writeAuthority: {
          inputHash: "0".repeat(64),
          assertCurrent() {},
          originalRecoveryCapture: {
            runId: run.runId,
            installRoot: process.cwd(),
            ref: {
              directory,
              manifestPath: path.join(directory, "manifest.json"),
              manifestSha256: "0".repeat(64),
            },
          },
        },
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(DoctorMaintenanceRefusalError);
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

it("keeps one sealed container capture, skips repeats, and still retires old captures", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const marker = state.path("activation-capture-marker");
    const env = { ...state.env, OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: marker };
    const captureRoot = resolveUpdateCaptureRoot(state.stateDir);
    const log = vi.fn();
    const preserve = (root: string | null) =>
      preserveDoctorOriginalState({
        root,
        env,
        runtime: { log, error: vi.fn(), exit: vi.fn() },
        signal: new AbortController().signal,
        assertCurrent() {},
      });

    // A nonfatal capture failure leaves the next start free to capture.
    await preserve(null);
    expect(fs.existsSync(marker)).toBe(false);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("Original state capture was unavailable"),
    );

    const capture = vi
      .spyOn(baselineCapture, "captureUpdateRecoveryBaseline")
      .mockImplementation(async ({ runId }) => {
        const directory = path.join(captureRoot, runId);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "manifest.json"), "{}");
        return {
          ref: {
            directory,
            manifestPath: path.join(directory, "manifest.json"),
            manifestSha256: "0".repeat(64),
          },
          warnings: [],
          diagnostics: { databaseWarnings: [] },
        };
      });
    const retire = vi
      .spyOn(retention, "retireExpiredStandaloneDoctorCaptures")
      .mockResolvedValue({ retired: [], warnings: [] });
    await preserve(process.cwd());
    expect(capture).toHaveBeenCalledOnce();
    const runId = fs.readFileSync(marker, "utf8");
    expect(runId).toBe(capture.mock.calls[0]![0].runId);

    log.mockClear();
    await preserve(process.cwd());
    expect(capture).toHaveBeenCalledOnce();
    expect(log.mock.calls).toEqual([
      [
        `This container already retained a pre-repair capture (${runId}); Doctor skipped a repeated full capture. Repair-specific backups still apply.`,
      ],
    ]);
    // Repeat starts keep the container's capture while older ones still age out.
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenLastCalledWith(expect.objectContaining({ keepRunId: runId }));

    // A marker whose capture is gone no longer suppresses capture.
    fs.rmSync(path.join(captureRoot, runId), { recursive: true });
    await preserve(process.cwd());
    expect(capture).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(marker, "utf8")).toBe(capture.mock.calls[1]![0].runId);
  });
});
