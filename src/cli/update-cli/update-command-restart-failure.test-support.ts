import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as servicePlan from "./update-command-service-plan.js";

export function registerRestartFailureOwnershipTest({
  makeTempDir,
  gatewayCommand,
}: {
  makeTempDir: (prefix: string) => string;
  gatewayCommand: Mock<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >;
}) {
  it("records a restart failure in the admitted ledger when service state uses another directory", async () => {
    const stateDir = makeTempDir("update-restart-owner-");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}\n", { mode: 0o600 });
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const run = { runId: createUpdateRun({ trigger: "api" }, { env }).runId, env };

    const serviceEnv = { ...env, OPENCLAW_STATE_DIR: makeTempDir("update-restart-service-") };
    vi.spyOn(servicePlan, "resolveGatewayServiceManagementBlockMessageForUpdate").mockReturnValue(
      undefined,
    );
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
  });
}
