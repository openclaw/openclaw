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
  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;
  return { program, browser, parentOpts };
}
