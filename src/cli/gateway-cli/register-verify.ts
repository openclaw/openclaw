import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";

export function addGatewayVerifyCommand(gateway: Command): void {
  gateway
    .command("verify")
    .description("Verify startup without listeners, migrations, or state writes")
    .option("--json", "Output machine-readable JSON", false)
    .action(async () => {
      try {
        const { verifyGatewayStartup } = await import("../../gateway/startup-verify.js");
        defaultRuntime.writeJson(await verifyGatewayStartup());
      } catch (error) {
        defaultRuntime.writeJson({
          ok: false,
          protocol: "openclaw.gateway.verify",
          protocolVersion: 1,
          error: error instanceof Error ? error.message : String(error),
        });
        defaultRuntime.exit(1);
      }
    });
}
