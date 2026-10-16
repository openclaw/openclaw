import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import { noteDoctorRepairResult } from "../flows/doctor-health-contribution-utils.js";
import * as ancestry from "../infra/restart-stale-pids.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  captureUpdateDoctorConfigWrites,
  DoctorMaintenanceRefusalError,
} from "../infra/update-doctor-result.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { preserveDoctorOriginalState } from "./doctor-original-capture.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "no-op",
  "advisory",
  "partial",
  "refused",
  "config-repair",
  "ledger-unavailable",
] as const)("retains original recovery only when needed after %s", async (scenario) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent() {},
      assertDatabaseAccess() {},
    });
    const run = async () => {
      const finish = await preserveDoctorOriginalState({
        root: process.cwd(),
        env: state.env,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      const captures = resolveUpdateCaptureRoot(state.stateDir);
      const name = (await fs.readdir(captures)).find((entry) => entry.startsWith("doctor-"));
      expect(name).toMatch(/^doctor-/);
      const manifest = path.join(captures, name!, "manifest.json");
      const before = await fs.readFile(manifest, "utf8");
      if (scenario === "config-repair") {
        await createConfigIO({ env: state.env }).writeConfigFile({
          gateway: { mode: "local", port: 19001 },
        });
      }
      if (scenario === "advisory" || scenario === "partial") {
        noteDoctorRepairResult(
          { changes: [], warnings: ["Synthetic notice"], completed: scenario === "advisory" },
          vi.fn(),
        );
      }
      if (scenario === "refused") {
        await createDoctorPrompter({
          options: { repair: true, nonInteractive: true },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        }).confirmAggressiveAutoFix({ message: "Synthetic repair", initialValue: true });
      }
      await finish?.();
      if (scenario === "no-op" || scenario === "advisory") {
        expect((await fs.readdir(captures)).filter((entry) => entry.startsWith("doctor-"))).toEqual(
          [],
        );
      } else {
        expect(await fs.readFile(manifest, "utf8")).toBe(before);
      }
    };
    try {
      await scope.run(() =>
        scenario === "ledger-unavailable"
          ? run()
          : captureUpdateDoctorConfigWrites(state.configPath, run),
      );
    } finally {
      await scope.close();
    }
  });
});

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
