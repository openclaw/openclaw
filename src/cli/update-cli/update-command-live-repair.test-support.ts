import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import * as repairAgent from "../../infra/update-repair-agent.js";
import * as runLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import * as servicePlan from "./update-command-service-plan.js";
import * as verificationOwner from "./update-command-verification.js";

export function registerLiveRepairOwnershipTests({
  makeTempDir,
  gatewayCommand,
}: {
  makeTempDir: (prefix: string) => string;
  gatewayCommand: Mock<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >;
}) {
  describe("live repair ownership after activation", () => {
    it.each([
      { transientRead: false, pending: false, repairStatus: "repaired" },
      { transientRead: true, pending: false, repairStatus: "repaired" },
      { transientRead: false, pending: true, repairStatus: "unrepaired" },
      { transientRead: false, pending: "still-starting", repairStatus: "unrepaired" },
      {
        transientRead: false,
        pending: "still-starting",
        repairStatus: "unrepaired",
        restored: true,
      },
      { transientRead: false, pending: true, repairStatus: "unavailable" },
      { transientRead: false, pending: true, repairStatus: "aborted" },
    ] as const)(
      "rechecks a restart failure using its own ledger (transient read=$transientRead, pending=$pending, repair=$repairStatus, restored=$restored)",
      async (testCase) => {
        const { transientRead, pending, repairStatus } = testCase;
        const restored = "restored" in testCase && testCase.restored;
        const stateDir = makeTempDir("update-live-repair-owner-");
        const configPath = path.join(stateDir, "openclaw.json");
        await fs.writeFile(configPath, "{}\n", { mode: 0o600 });
        const env = {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        };
        const run = { runId: createUpdateRun({ trigger: "api" }, { env }).runId, env };

        const serviceEnv = { ...env, OPENCLAW_STATE_DIR: makeTempDir("update-repair-service-") };
        vi.spyOn(
          servicePlan,
          "resolveGatewayServiceManagementBlockMessageForUpdate",
        ).mockReturnValue(undefined);
        const service = await vi.importActual<typeof import("./update-command-service.js")>(
          "./update-command-service.js",
        );
        gatewayCommand.mockRejectedValueOnce(new Error("candidate restart failed"));
        expect(
          await service.maybeRestartService({
            shouldRestart: true,
            result: { status: "ok", mode: "npm", root: "/repo", steps: [], durationMs: 1 },
            opts: { json: true, run },
            refreshServiceEnv: false,
            serviceEnv,
            serviceUpdateVerdict: { kind: "unresolved", root: "/repo", fingerprint: "fixture" },
            gatewayPort: 19101,
            timeoutMs: 1_000,
          }),
        ).toBe("failed");
        expect(gatewayCommand).toHaveBeenCalled();
        expect(getUpdateRun(run.runId, { env })).toMatchObject({
          status: "running",
          phase: "verifying",
        });
        const commandsBeforeRepair = gatewayCommand.mock.calls.length;
        const failed = { ok: false, score: 0, summary: "Candidate boot failed." };
        const verified = { ok: true, score: 1, summary: "Gateway is ready." };
        const stillStarting = {
          ok: false,
          score: 1,
          summary: "Gateway is still starting; readiness remains unverified.",
          stopReason: pending === "still-starting" ? "still-starting" : "gateway-readiness-pending",
        };
        const verify = vi
          .spyOn(verificationOwner, "verifyUpdatedGateway")
          .mockResolvedValueOnce(failed)
          .mockImplementationOnce(async ({ result }) => {
            if (!pending) {
              return failed;
            }
            result.steps.push({
              name: "gateway verification",
              command: "gateway verification",
              cwd: "/repo",
              durationMs: 90_000,
              exitCode: 0,
              termination: "timeout",
              advisory: { kind: "recoverable-maintenance", message: stillStarting.summary },
            });
            return stillStarting;
          })
          .mockResolvedValueOnce(verified);
        const prepare = vi
          .spyOn(repairAgent, "prepareUnattendedUpdateRepair")
          .mockImplementation(async (repair) => {
            // A failed restart never reached ordinary verification. Live repair must
            // own the durable repair phase before the candidate worker is admitted.
            expect(getUpdateRun(run.runId, { env })).toMatchObject({
              status: "running",
              phase: "repairing",
            });
            if (transientRead) {
              const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
              vi.spyOn(runLedger, "getUpdateRun").mockImplementationOnce(() => {
                throw busy;
              });
              expect(repair.isCurrent).toThrow(busy);
            }
            expect(repair.isCurrent?.()).toBe(true);
            const signal = new AbortController().signal;
            expect(await repair.validate(signal)).toEqual(failed);
            repair.onEvent?.({
              type: "turn-started",
              turn: 1,
              provider: "openai",
              model: "gpt-5.6-luna",
            });
            const validation = await repair.validate(signal);
            expect(validation).toEqual(pending ? stillStarting : verified);
            const reason =
              repairStatus === "unavailable" || repairStatus === "aborted"
                ? "worker failed after validation"
                : validation.stopReason;
            repair.onEvent?.({ type: "stopped", status: repairStatus, reason });
            return { status: repairStatus, reason, attempts: [], finalValidation: validation };
          });
        const result = await repairUpdateService({
          result: {
            status: "error",
            reason: "restart-unhealthy",
            mode: "npm",
            root: "/repo",
            before: { version: "2026.9.1" },
            after: restored
              ? { version: "2026.9.1", buildId: "restored-build" }
              : { version: "2026.9.3" },
            ...(restored
              ? {
                  recovery: {
                    serviceRestartSafe: true as const,
                    packageRollbackVerified: true as const,
                    version: "2026.9.1",
                    buildId: "restored-build",
                    service: "failed" as const,
                    reason: "channel-errors",
                  },
                }
              : {}),
            steps: [],
            durationMs: 1,
          },
          root: "/repo",
          env: serviceEnv,
          opts: { json: true, run },
          gatewayPort: 19101,
          timeoutMs: 1_000,
          expectedService: { serviceEnv },
        });
        const repairFailed = repairStatus === "unavailable" || repairStatus === "aborted";
        expect(result).toMatchObject({ status: repairFailed ? "error" : "ok" });
        expect(gatewayCommand).toHaveBeenCalledTimes(commandsBeforeRepair + (pending ? 0 : 1));
        expect(prepare).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenCalledTimes(pending ? 2 : 3);
        expect(getUpdateRun(run.runId, { env })).toMatchObject({
          status: "running",
          repair: [expect.objectContaining({ status: pending ? "failed" : "succeeded" })],
        });
        if (pending) {
          expect(result.reason).toBe(
            repairFailed ? "restart-unhealthy" : pending === "still-starting" ? pending : undefined,
          );
          if (restored) {
            expect(result.after).toEqual({ version: "2026.9.1", buildId: "restored-build" });
            expect(result.recovery).toEqual({
              serviceRestartSafe: true,
              packageRollbackVerified: true,
              version: "2026.9.1",
              buildId: "restored-build",
              service: undefined,
              reason: "still-starting",
            });
          } else {
            expect(result.recovery).toBeUndefined();
          }
          expect(result.steps).toEqual([
            expect.objectContaining({
              termination: "timeout",
              advisory: { kind: "recoverable-maintenance", message: stillStarting.summary },
            }),
          ]);
        }
      },
    );
  });
}
