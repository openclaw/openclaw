import type { Command } from "commander";

import {
  browserDom,
  browserQuery,
  browserScreenshot,
  browserSnapshot,
  resolveBrowserControlUrl,
} from "../browser/client.js";
import { browserScreenshotAction } from "../browser/client-actions.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserInspectCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("screenshot")
    .description("Capture a screenshot (MEDIA:<path>)")
    .argument("[targetId]", "CDP target id (or unique prefix)")
    .option("--full-page", "Capture full scrollable page", false)
    .option("--ref <ref>", "ARIA ref from ai snapshot")
    .option("--element <selector>", "CSS selector for element screenshot")
    .option("--type <png|jpeg>", "Output type (default: png)", "png")
    .option("--filename <name>", "Preferred output filename")
    .action(async (targetId: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const advanced = Boolean(opts.ref || opts.element || opts.filename);
        const result = advanced
          ? await browserScreenshotAction(baseUrl, {
              targetId: targetId?.trim() || undefined,
              fullPage: Boolean(opts.fullPage),
              ref: opts.ref?.trim() || undefined,
              element: opts.element?.trim() || undefined,
              filename: opts.filename?.trim() || undefined,
              type: opts.type === "jpeg" ? "jpeg" : "png",
            })
          : await browserScreenshot(baseUrl, {
              targetId: targetId?.trim() || undefined,
              fullPage: Boolean(opts.fullPage),
            });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`MEDIA:${result.path}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("query")
    .description("Query selector matches")
    .argument("<selector>", "CSS selector")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--limit <n>", "Max matches (default: 20)", (v: string) =>
      Number(v),
    )
    .action(async (selector: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const result = await browserQuery(baseUrl, {
          selector,
          targetId: opts.targetId?.trim() || undefined,
          limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(JSON.stringify(result.matches, null, 2));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("dom")
    .description("Dump DOM (html or text) with truncation")
    .option("--format <html|text>", "Output format (default: html)", "html")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--selector <css>", "Optional CSS selector to scope the dump")
    .option(
      "--max-chars <n>",
      "Max characters (default: 200000)",
      (v: string) => Number(v),
    )
    .option("--out <path>", "Write output to a file")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const format = opts.format === "text" ? "text" : "html";
      try {
        const result = await browserDom(baseUrl, {
          format,
          targetId: opts.targetId?.trim() || undefined,
          maxChars: Number.isFinite(opts.maxChars) ? opts.maxChars : undefined,
          selector: opts.selector?.trim() || undefined,
        });
        if (opts.out) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(opts.out, result.text, "utf8");
          if (parent?.json) {
            defaultRuntime.log(
              JSON.stringify({ ok: true, out: opts.out }, null, 2),
            );
          } else {
            defaultRuntime.log(opts.out);
          }
          return;
        }
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(result.text);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("snapshot")
    .description("Capture an AI-friendly snapshot (aria, domSnapshot, or ai)")
    .option(
      "--format <aria|domSnapshot|ai>",
      "Snapshot format (default: aria)",
      "aria",
    )
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--limit <n>", "Max nodes (default: 500/800)", (v: string) =>
      Number(v),
    )
    .option("--out <path>", "Write snapshot to a file")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const format =
        opts.format === "domSnapshot"
          ? "domSnapshot"
          : opts.format === "ai"
            ? "ai"
            : "aria";
      try {
        const result = await browserSnapshot(baseUrl, {
          format,
          targetId: opts.targetId?.trim() || undefined,
          limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
        });

        if (opts.out) {
          const fs = await import("node:fs/promises");
          if (result.format === "ai") {
            await fs.writeFile(opts.out, result.snapshot, "utf8");
          } else {
            const payload = JSON.stringify(result, null, 2);
            await fs.writeFile(opts.out, payload, "utf8");
          }
          if (parent?.json) {
            defaultRuntime.log(
              JSON.stringify({ ok: true, out: opts.out }, null, 2),
            );
          } else {
            defaultRuntime.log(opts.out);
          }
          return;
        }

        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.format === "ai") {
          defaultRuntime.log(result.snapshot);
          return;
        }

        if (result.format === "domSnapshot") {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        const nodes = "nodes" in result ? result.nodes : [];
        defaultRuntime.log(
          nodes
            .map((n) => {
              const indent = "  ".repeat(Math.min(20, n.depth));
              const name = n.name ? ` "${n.name}"` : "";
              const value = n.value ? ` = "${n.value}"` : "";
              return `${indent}- ${n.role}${name}${value}`;
            })
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
