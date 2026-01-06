import type { Command } from "commander";
import { resolveBrowserControlUrl } from "../browser/client.js";
import {
  browserConsoleMessages,
  browserPdfSave,
} from "../browser/client-actions.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserActionObserveCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("console")
    .description("Get recent console messages")
    .option("--level <level>", "Filter by level (error, warn, info)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const result = await browserConsoleMessages(baseUrl, {
          level: opts.level?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(JSON.stringify(result.messages, null, 2));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("pdf")
    .description("Save page as PDF")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const result = await browserPdfSave(baseUrl, {
          targetId: opts.targetId?.trim() || undefined,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`PDF: ${result.path}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
