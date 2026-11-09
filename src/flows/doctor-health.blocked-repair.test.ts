import "./doctor-health.test-support.js";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { recordDoctorGatewayRestorationRefusal } from "../commands/doctor-maintenance-restoration.js";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../infra/update-doctor-result.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveFinalDoctorHealthContributions } from "./doctor-health-contributions-final.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");
const beginMaintenance = doctorMaintenance.beginDoctorMaintenance;
const actualResult = await vi.importActual<typeof import("../infra/update-doctor-result.js")>(
  "../infra/update-doctor-result.js",
);

// Keep the real final registry entry, snapshot reader, flow settlement, and IPC codec.
// The shared fixture replaces host service IO and unrelated health contributions.
const finalValidation = resolveFinalDoctorHealthContributions({
  runSystemdLingerHealth: async () => {},
  detectSystemdLingerFindings: async () => [],
  runShellCompletionHealth: async () => {},
  runGatewayHealthChecks: async () => {},
}).find((entry) => entry.id === "doctor:final-config-validation");
if (!finalValidation) {
  throw new Error("Missing final config validation contribution");
}

describe("Doctor final repair settlement", () => {
  useDoctorHealthFixture();
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.writeUpdatePostInstallDoctorResult.mockReset();
  });

  it.each([
    { kind: "invalid", repair: true, blocked: true, mode: "standard" },
    { kind: "required", repair: true, blocked: true, mode: "standard" },
    { kind: "conditional", repair: true, blocked: false, mode: "standard" },
    { kind: "valid", repair: true, blocked: false, mode: "standard" },
    { kind: "invalid", repair: false, blocked: false, mode: "standard" },
    { kind: "invalid", repair: false, blocked: true, mode: "updater" },
    { kind: "required", repair: false, blocked: true, mode: "updater" },
    { kind: "invalid", repair: false, blocked: true, mode: "interactive" },
    { kind: "required", repair: false, blocked: true, mode: "interactive" },
  ] as const)(
    "settles $kind config/migration (repair=$repair, mode=$mode)",
    async ({ kind, repair, blocked, mode }) => {
      await withOpenClawTestState(
        {
          scenario: "minimal",
          env: {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: mode === "updater" ? "1" : undefined,
          },
        },
        async (state) => {
          mocks.emulateNativeInstall = false;
          const cfg = { gateway: { mode: "local" as const }, plugins: { enabled: false } };
          mocks.config.mockReturnValue(cfg);
          await state.writeConfig(cfg);
          if (kind === "invalid") {
            // Config preparation has completed; the final boundary must re-read persisted bytes.
            await fs.writeFile(state.configPath, '{"gateway": {broken json');
          }
          const resultPath = createUpdatePostInstallDoctorResultPath();
          vi.stubEnv(UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV, resultPath);
          mocks.writeUpdatePostInstallDoctorResult.mockImplementation(
            actualResult.writeUpdatePostInstallDoctorResult,
          );
          // Run real maintenance finish, then model a handled native authority refusal through
          // its real recorder. Aggregation must read the owner after finish, not before it.
          vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockImplementation(
            async (params) => {
              const maintenance = await beginMaintenance(params);
              if (maintenance) {
                const finish = maintenance.finish.bind(maintenance);
                vi.spyOn(maintenance, "finish").mockImplementation(async (...args) => {
                  await finish(...args);
                  await recordDoctorGatewayRestorationRefusal({
                    serviceEnv: state.env,
                    error: new GatewayServiceAuthorityError(
                      "Synthetic restoration refusal.",
                      "unchanged",
                    ),
                    before: {
                      stopped: true,
                      inspected: true,
                      runtimeInspected: true,
                      running: false,
                    },
                    warnings: maintenance.warnings,
                    failureFacts: maintenance.failureFacts,
                    runtime: params.runtime,
                  });
                });
              }
              return maintenance;
            },
          );
          const priorFact = {
            check: "prior-check",
            code: "prior-fact",
            message: "Retain prior facts.",
          };
          mocks.runContributions.mockImplementation(async (ctx) => {
            expect(ctx.prompter.shouldRepair).toBe(repair);
            expect(ctx.gatewayMaintenanceActive).toBe(repair || mode === "interactive");
            ctx.configResult.warnings = ["Retain config preparation warning."];
            ctx.configResult.stateMigrationStepReceipts = [
              {
                id: "synthetic-warning-migration",
                phase: "final",
                source: [],
                target: [],
                requiredness: "conditional",
                reversibility: "checkpoint-required",
                outcome: "warning",
                changes: [],
                warnings: ["Retain distinct receipt warning."],
              },
            ];
            ctx.postInstallDoctorResult = {
              status: "ok",
              warnings: ["Retain prior warning."],
              failureFacts: [priorFact],
            };
            if (kind === "required" || kind === "conditional") {
              const receipt: LegacyStateMigrationStepReceipt = {
                id: "synthetic-required-migration",
                phase: "final",
                source: [],
                target: [],
                requiredness: kind,
                reversibility: "checkpoint-required",
                outcome: "deferred",
                changes: [],
                warnings: ["Resolve synthetic migration blocker."],
              };
              ctx.configResult.stateMigrationStepReceipts.push(receipt);
            }
            await finalValidation.run(ctx);
          });
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const ttyMock = createCliTtyMock();
          ttyMock.set(mode === "interactive");
          mocks.confirm.mockReset().mockResolvedValue(true);
          try {
            await runDoctorHealthFlow(
              runtime,
              mode === "standard"
                ? { repair, nonInteractive: true }
                : mode === "updater"
                  ? { nonInteractive: true }
                  : {},
            );
            const result = await consumeUpdatePostInstallDoctorResult(resultPath);
            expect(result).toMatchObject({
              status: blocked ? "error" : "ok",
              warnings: expect.arrayContaining([
                "Retain config preparation warning.",
                "Retain distinct receipt warning.",
                "Retain prior warning.",
              ]),
              failureFacts: expect.arrayContaining([priorFact]),
            });
            if (repair || mode === "interactive") {
              expect(result?.failureFacts).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    check: "gateway-restoration",
                    code: "service-authority-revoked-unchanged",
                  }),
                ]),
              );
              expect(result?.warnings).toEqual(
                expect.arrayContaining([
                  expect.stringContaining("maintenance authority (unchanged)"),
                ]),
              );
            }
            if (kind === "required" || kind === "conditional") {
              expect(result?.warnings).toContain("Resolve synthetic migration blocker.");
            }
            if (blocked) {
              expect(runtime.exit).toHaveBeenCalledWith(1);
              expect(mocks.outro).toHaveBeenCalledWith(
                "Doctor blocked; required repairs remain incomplete.",
              );
              expect(result?.failureFacts).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    code: kind === "invalid" ? "valid-config" : "required-migration-deferred",
                  }),
                ]),
              );
            } else {
              expect(runtime.exit).not.toHaveBeenCalledWith(1);
              expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
            }
            if (kind === "invalid") {
              expect(runtime.error).toHaveBeenCalled();
            }
          } finally {
            ttyMock.restore();
            mocks.confirm.mockReset().mockResolvedValue(true);
            await consumeUpdatePostInstallDoctorResult(resultPath);
          }
        },
      );
    },
  );
});
