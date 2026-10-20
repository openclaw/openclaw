import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { gatewayAction } from "./gateway-action.js";

export function addGatewayLockRecoveryCommand(gateway: Command): void {
  gateway
    .command("recover-lock")
    .description("Inspect or explicitly recover an unchanged Gateway state lock")
    .option("--confirm <fingerprint>", "Recover only the lock record shown by a prior inspection")
    .option("--json", "Output JSON", false)
    .action(
      gatewayAction(async (opts: { confirm?: string; json?: boolean }) => {
        const { inspectGatewayLockRecovery, recoverGatewayLock } =
          await import("../../infra/gateway-lock-recovery.js");
        if (opts.confirm) {
          const result = await recoverGatewayLock({ confirmation: opts.confirm });
          if (opts.json) {
            defaultRuntime.writeJson(result);
          } else {
            defaultRuntime.log("Gateway lock recovery completed. Start the Gateway again.");
          }
          return;
        }
        const inspection = await inspectGatewayLockRecovery();
        const command = formatCliCommand(
          `openclaw gateway recover-lock --confirm ${inspection.confirmation}`,
        );
        if (opts.json) {
          defaultRuntime.writeJson({
            present: inspection.present,
            holders: inspection.holders,
            confirmation: inspection.confirmation,
            command,
          });
          return;
        }
        if (!inspection.present) {
          defaultRuntime.log("No Gateway lock or owner lease is present.");
          return;
        }
        for (const holder of inspection.holders) {
          defaultRuntime.log(holder);
        }
        defaultRuntime.log(
          "Stop the recorded holder through its service manager or container first. " +
            "If you have confirmed it stopped, recover exactly these unchanged records with:",
        );
        defaultRuntime.log(command);
      }, "Gateway lock recovery failed"),
    );
}
