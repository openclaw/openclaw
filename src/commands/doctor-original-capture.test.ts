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
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  signal: new AbortController().signal,
  assertCurrent() {},
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
            elapsed = 10 * 60_000;
            assertCurrent();
          } else {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
          }
          signal?.throwIfAborted();
          return captured(state.stateDir);
        },
      );
      const result = await preserveDoctorOriginalState({ ...captureDefaults(), env: state.env });
      expect(result.warnings.join("\n")).toContain("timed out after 600 s");
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

it("keeps one sealed container capture, skips repeats, and still retires old captures", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const marker = state.path("activation-capture-marker");
    const env = { ...state.env, OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: marker };
    const captureRoot = resolveUpdateCaptureRoot(state.stateDir);
    const log = vi.fn();
    const captureOriginal = (root: string | null) =>
      preserveDoctorOriginalState({
        ...captureDefaults(),
        root,
        env,
        runtime: { log, error: vi.fn(), exit: vi.fn() },
      });

    // A nonfatal capture failure leaves the next start free to capture.
    const unavailable = await captureOriginal(null);
    expect(fs.existsSync(marker)).toBe(false);
    expect(unavailable.findings).toContainEqual(
      expect.objectContaining({
        category: "fix-now",
        message: expect.stringContaining("Pre-repair recovery copy was unavailable"),
        fixHint: expect.stringContaining("Check installation access and disk space"),
      }),
    );

    const capture = vi
      .spyOn(baselineCapture, "captureUpdateRecoveryBaseline")
      .mockImplementation(async ({ runId }) => {
        const directory = path.join(captureRoot, runId);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "manifest.json"), "{}");
        return captured(directory);
      });
    const retire = vi
      .spyOn(retention, "retireExpiredStandaloneDoctorCaptures")
      .mockResolvedValue({ retired: [], warnings: [] });
    await captureOriginal(process.cwd());
    expect(capture).toHaveBeenCalledOnce();
    const runId = fs.readFileSync(marker, "utf8");
    expect(runId).toBe(capture.mock.calls[0]![0].runId);

    log.mockClear();
    await captureOriginal(process.cwd());
    expect(capture).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    // Repeat starts keep the container's capture while older ones still age out.
    expect(retire).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenLastCalledWith(expect.objectContaining({ keepRunId: runId }));

    fs.rmSync(path.join(captureRoot, runId), { recursive: true });
    await captureOriginal(process.cwd());
    expect(capture).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(marker, "utf8")).toBe(capture.mock.calls[1]![0].runId);
  });
});
