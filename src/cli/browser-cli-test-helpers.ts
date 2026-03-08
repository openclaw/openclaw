import { Command } from "commander";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

export function createBrowserProgram(params?: { withGatewayUrl?: boolean }): {
  program: Command;
  browser: Command;
  parentOpts: (cmd: Command) => BrowserParentOpts;
} {
  const program = new Command();
  const browser = program
    .command("browser")
    .option("--browser-profile <name>", "Browser profile")
    .option("--json", "Output JSON", false);
  if (params?.withGatewayUrl) {
    browser.option("--url <url>", "Gateway WebSocket URL");
  }
  const parentOpts = (cmd: Command) => {
    const parent = cmd.parent;
    const opts = parent?.opts?.() ?? {};
    const timeoutSource =
      typeof parent?.getOptionValueSource === "function"
        ? parent.getOptionValueSource("timeout")
        : undefined;
    return {
      ...opts,
      ...(timeoutSource ? { timeoutSource } : {}),
    };
  };
  return { program, browser, parentOpts };
}
