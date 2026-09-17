import type { GatewayServiceEnv } from "./service-types.js";
import { execSystemctlUser, isSystemdUnitActive, readSystemctlDetail } from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

/** Capture native policy while the definition writer holds the original artifacts. */
export async function captureSystemdInstallRecovery(env: GatewayServiceEnv, installed: boolean) {
  const unit = `${resolveSystemdServiceName(env)}.service`;
  let enabled = "disabled";
  let running = false;
  if (installed) {
    const enablement = await execSystemctlUser(env, ["is-enabled", unit]);
    enabled = enablement.stdout.trim();
    if (
      enablement.termination !== "exit" ||
      !["enabled", "enabled-runtime", "disabled", "static", "indirect"].includes(enabled)
    ) {
      throw new Error(
        `Cannot preserve the existing systemd enablement policy before replacing its definition; no service files were changed: ${readSystemctlDetail(enablement)}`,
      );
    }
    const active = await isSystemdUnitActive(env, unit);
    if (!active.ok) {
      throw new Error(
        `Cannot preserve the existing systemd running state before replacing its definition; no service files were changed: ${active.error}`,
      );
    }
    running = active.value;
  }
  let activationAttempted = false;
  let restartAttempted = false;
  return {
    beforeAction: (action: string) => {
      activationAttempted = true;
      restartAttempted ||= action === "restart";
    },
    async restore() {
      if (!activationAttempted) {
        return;
      }
      const run = async (args: string[]) => {
        await assertNoSystemGatewayOwnership(env);
        const result = await execSystemctlUser(env, args);
        if (result.code !== 0) {
          throw new Error(`systemctl rollback ${args[0]} failed: ${readSystemctlDetail(result)}`);
        }
      };
      if (enabled !== "enabled") {
        await run(["disable", unit]);
        if (enabled === "enabled-runtime") {
          await run(["enable", "--runtime", unit]);
        }
      }
      await run(["daemon-reload"]);
      if (restartAttempted) {
        await run([running ? "restart" : "stop", unit]);
      }
    },
  };
}
