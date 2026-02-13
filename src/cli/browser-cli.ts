import type { Command } from "commander";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions } from "./gateway-rpc.js";
import { formatHelpExamples } from "./help-format.js";

export async function registerBrowserCli(program: Command) {
  const { browserActionExamples, browserCoreExamples } = await import("./browser-cli-examples.js");

  const browser = program
    .command("browser")
    .description("Manage OpenClaw's dedicated browser (Chrome/Chromium)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          [...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]),
          true,
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/browser",
          "docs.openclaw.ai/cli/browser",
        )}\n`,
    )
    .action(() => {
      browser.outputHelp();
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`),
      );
      defaultRuntime.exit(1);
    });

  addGatewayClientOptions(browser);

  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;

  // Load all browser sub-command registrations in parallel
  const [
    { registerBrowserManageCommands },
    { registerBrowserExtensionCommands },
    { registerBrowserInspectCommands },
    { registerBrowserActionInputCommands },
    { registerBrowserActionObserveCommands },
    { registerBrowserDebugCommands },
    { registerBrowserStateCommands },
  ] = await Promise.all([
    import("./browser-cli-manage.js"),
    import("./browser-cli-extension.js"),
    import("./browser-cli-inspect.js"),
    import("./browser-cli-actions-input.js"),
    import("./browser-cli-actions-observe.js"),
    import("./browser-cli-debug.js"),
    import("./browser-cli-state.js"),
  ]);

  registerBrowserManageCommands(browser, parentOpts);
  registerBrowserExtensionCommands(browser, parentOpts);
  registerBrowserInspectCommands(browser, parentOpts);
  registerBrowserActionInputCommands(browser, parentOpts);
  registerBrowserActionObserveCommands(browser, parentOpts);
  registerBrowserDebugCommands(browser, parentOpts);
  registerBrowserStateCommands(browser, parentOpts);
}
