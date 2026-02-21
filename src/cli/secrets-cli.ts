import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

type SecretsReloadOptions = GatewayRpcOpts & { json?: boolean };

export function registerSecretsCli(program: Command) {
  const secrets = program
    .command("secrets")
    .description("Secrets runtime controls")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/security", "docs.openclaw.ai/gateway/security")}\n`,
    );

  addGatewayClientOptions(
    secrets
      .command("reload")
      .description("Re-resolve secret references and atomically swap runtime snapshot")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SecretsReloadOptions) => {
    try {
      const result = await callGatewayFromCli("secrets.reload", opts, undefined, {
        expectFinal: false,
      });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(result, null, 2));
        return;
      }
      const warningCount = Number(
        (result as { warningCount?: unknown } | undefined)?.warningCount ?? 0,
      );
      if (Number.isFinite(warningCount) && warningCount > 0) {
        defaultRuntime.log(`Secrets reloaded with ${warningCount} warning(s).`);
        return;
      }
      defaultRuntime.log("Secrets reloaded.");
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  });
}
