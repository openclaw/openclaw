import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

export function registerDaemonCli(program: Command) {
	// Original 'daemon' command - continues to work
	const daemon = program
		.command("daemon")
		.description("Manage the Gateway service (launchd/systemd/schtasks)")
		.addHelpText(
			"after",
			() =>
				`\n${theme.muted("Tip:")} Use ${theme.highlight("'service'")} command on Windows for native SCM support.\n` +
				`${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
		);

	addGatewayServiceCommands(daemon, {
		statusDescription: "Show service install status + probe the Gateway",
	});
}

/**
 * Register the 'service' command group - Windows native, cross-platform consistent
 * Reuses the same implementation as daemon command
 */
export function registerServiceCli(program: Command) {
	const service = program
		.command("service")
		.description(
			"Manage the Gateway service (Windows SCM/macOS launchd/Linux systemd)",
		)
		.addHelpText(
			"after",
			() =>
				`\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
		);

	addGatewayServiceCommands(service, {
		statusDescription: "Show service install status + probe the Gateway",
	});
}
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

export function registerDaemonCli(program: Command) {
	// Original 'daemon' command - continues to work
	const daemon = program
		.command("daemon")
		.description("Manage the Gateway service (launchd/systemd/schtasks)")
		.addHelpText(
			"after",
			() =>
				`\n${theme.muted("Tip:")} Use ${theme.highlight("'service'")} command on Windows for native SCM support.\n` +
				`${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
		);

	addGatewayServiceCommands(daemon, {
		statusDescription: "Show service install status + probe the Gateway",
	});

	// New 'service' command - Windows native, cross-platform consistent
	const service = program
		.command("service")
		.description(
			"Manage the Gateway service (Windows SCM/macOS launchd/Linux systemd)",
		)
		.addHelpText(
			"after",
			() =>
				`\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
		);

	addGatewayServiceCommands(service, {
		statusDescription: "Show service install status + probe the Gateway",
	});
}
