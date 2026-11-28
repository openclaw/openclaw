import { Option, type Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { gatewayAction } from "./gateway-action.js";

type RecoveryOptions = { confirm?: string; terminatedNamespace?: string; json?: boolean };

export function addGatewayLockRecoveryCommand(gateway: Command): void {
  gateway
    .command("recover-lock", { hidden: true })
    .description("Inspect or explicitly recover an unchanged Gateway state lock")
    .option("--confirm <fingerprint>", "Recover only the lock record shown by a prior inspection")
    .addOption(
      new Option(
        "--terminated-namespace <json>",
        "Recover holders in a Linux PID namespace the supervisor verified stopped",
      ).conflicts("confirm"),
    )
    .option("--json", "Output JSON", false)
    .action(
      gatewayAction(async (opts: RecoveryOptions) => {
        const { inspectGatewayLockRecovery, recoverGatewayLock } =
          await import("../../infra/gateway-lock-recovery.js");
        let result;
        if (opts.terminatedNamespace !== undefined) {
          result = await recoverGatewayLock({
            terminatedNamespace: JSON.parse(opts.terminatedNamespace) as unknown,
          });
        } else if (opts.confirm !== undefined) {
          result = await recoverGatewayLock({ confirmation: opts.confirm });
        }
        if (result) {
          if (opts.json) {
            defaultRuntime.writeJson(result);
          } else {
            defaultRuntime.log("Gateway lock recovery completed. Start the Gateway again.");
          }
          return;
        }
        const inspection = await inspectGatewayLockRecovery();
        if (opts.json) {
          defaultRuntime.writeJson({
            present: inspection.present,
            holders: inspection.holders,
            confirmation: inspection.confirmation,
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
        defaultRuntime.log("Independently verify that the recorded holder has stopped.");
        defaultRuntime.log(`Confirmation fingerprint: ${inspection.confirmation}`);
      }, "Gateway lock recovery failed"),
    );
}
