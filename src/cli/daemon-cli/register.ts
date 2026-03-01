export function registerDaemonCli(program: Command) {
  const daemon = program
    .command("daemon")
    .description("Manage the Gateway service (launchd/systemd/schtasks)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
    );

  addGatewayServiceCommands(daemon, {
    statusDescription: "Show service install status + probe the Gateway",
  });

  // Add 'service' as alias for 'daemon' command
  const service = program
    .command("service")
    .description(
      "Manage the Gateway service (Windows SCM/macOS launchd/Linux systemd)",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Alias for:")} daemon\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
    );

  addGatewayServiceCommands(service, {
    statusDescription: "Show service install status + probe the Gateway",
  });
}
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

export function registerDaemonCli(program: Command) {
  const daemon = program
    .command("daemon")
    .description("Manage the Gateway service (launchd/systemd/schtasks)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
    );

  addGatewayServiceCommands(daemon, {
    statusDescription: "Show service install status + probe the Gateway",
  });
}
