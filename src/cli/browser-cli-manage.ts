import type { Command } from "commander";

import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
  resolveBrowserControlUrl,
} from "../browser/client.js";
import { browserAct } from "../browser/client-actions.js";
import { danger, info } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserManageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("status")
    .description("Show browser status")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(
          [
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `controlUrl: ${status.controlUrl}`,
            `cdpPort: ${status.cdpPort}`,
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `profileColor: ${status.color}`,
          ].join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("start")
    .description("Start the clawd browser (no-op if already running)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserStart(baseUrl);
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(info(`🦞 clawd browser running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("stop")
    .description("Stop the clawd browser (best-effort)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserStop(baseUrl);
        const status = await browserStatus(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(info(`🦞 clawd browser running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("tabs")
    .description("List open tabs")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const tabs = await browserTabs(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ tabs }, null, 2));
          return;
        }
        if (tabs.length === 0) {
          defaultRuntime.log("No tabs (browser closed or no targets).");
          return;
        }
        defaultRuntime.log(
          tabs
            .map(
              (t, i) =>
                `${i + 1}. ${t.title || "(untitled)"}\n   ${t.url}\n   id: ${t.targetId}`,
            )
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .action(async (url: string, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const tab = await browserOpenTab(baseUrl, url);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(tab, null, 2));
          return;
        }
        defaultRuntime.log(`opened: ${tab.url}\nid: ${tab.targetId}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("focus")
    .description("Focus a tab by target id (or unique prefix)")
    .argument("<targetId>", "Target id or unique prefix")
    .action(async (targetId: string, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        await browserFocusTab(baseUrl, targetId);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log(`focused tab ${targetId}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("close")
    .description("Close a tab (target id optional)")
    .argument("[targetId]", "Target id or unique prefix (optional)")
    .action(async (targetId: string | undefined, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        if (targetId?.trim()) {
          await browserCloseTab(baseUrl, targetId.trim());
        } else {
          await browserAct(baseUrl, { kind: "close" });
        }
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log("closed tab");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
