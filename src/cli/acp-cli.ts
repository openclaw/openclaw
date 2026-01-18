import type { Command } from "commander";

import { serveAcpGateway } from "../acp/server.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerAcpCli(program: Command) {
  program
    .command("acp")
    .description("Run an ACP bridge backed by the Gateway")
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
    .option("--session <key>", "Default session key (e.g. agent:main:main)")
    .option("--session-label <label>", "Default session label to resolve")
    .option("--require-existing", "Fail if the session key/label does not exist", false)
    .option("--reset-session", "Reset the session key before first use", false)
    .option("--no-prefix-cwd", "Do not prefix prompts with the working directory", false)
    .option("--verbose, -v", "Verbose logging to stderr", false)
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.clawd.bot/cli/acp")}\n`,
    )
    .action((opts) => {
      try {
        serveAcpGateway({
          gatewayUrl: opts.url as string | undefined,
          gatewayToken: opts.token as string | undefined,
          gatewayPassword: opts.password as string | undefined,
          defaultSessionKey: opts.session as string | undefined,
          defaultSessionLabel: opts.sessionLabel as string | undefined,
          requireExistingSession: Boolean(opts.requireExisting),
          resetSession: Boolean(opts.resetSession),
          prefixCwd: !opts.noPrefixCwd,
          verbose: Boolean(opts.verbose),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
