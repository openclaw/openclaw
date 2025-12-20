import type { Command } from "commander";
import { resolveBrowserControlUrl } from "../browser/client.js";
import {
  browserConsoleMessages,
  browserMouseClick,
  browserMouseDrag,
  browserMouseMove,
  browserPdfSave,
  browserVerifyElementVisible,
  browserVerifyListVisible,
  browserVerifyTextVisible,
  browserVerifyValue,
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
      try {
        const result = await browserConsoleMessages(baseUrl, {
          level: opts.level?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
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
      try {
        const result = await browserPdfSave(baseUrl, {
          targetId: opts.targetId?.trim() || undefined,
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

  browser
    .command("verify-element")
    .description("Verify element visible by role + name")
    .option("--role <role>", "ARIA role")
    .option("--name <text>", "Accessible name")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      if (!opts.role || !opts.name) {
        defaultRuntime.error(danger("--role and --name are required"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserVerifyElementVisible(baseUrl, {
          role: opts.role,
          accessibleName: opts.name,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("element visible");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("verify-text")
    .description("Verify text is visible")
    .argument("<text>", "Text to find")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (text: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const result = await browserVerifyTextVisible(baseUrl, {
          text,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("text visible");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("verify-list")
    .description("Verify list items under a ref")
    .argument("<ref>", "Ref id from ai snapshot")
    .argument("<items...>", "List items to verify")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, items: string[], opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const result = await browserVerifyListVisible(baseUrl, {
          ref,
          items,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("list visible");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("verify-value")
    .description("Verify a form control value")
    .option("--ref <ref>", "Ref id from ai snapshot")
    .option("--type <type>", "Input type (textbox, checkbox, slider, etc)")
    .option("--value <value>", "Expected value")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      if (!opts.ref || !opts.type) {
        defaultRuntime.error(danger("--ref and --type are required"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserVerifyValue(baseUrl, {
          ref: opts.ref,
          type: opts.type,
          value: opts.value,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("value verified");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("mouse-move")
    .description("Move mouse to viewport coordinates")
    .option("--x <n>", "X coordinate", (v: string) => Number(v))
    .option("--y <n>", "Y coordinate", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      if (!Number.isFinite(opts.x) || !Number.isFinite(opts.y)) {
        defaultRuntime.error(danger("--x and --y are required"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserMouseMove(baseUrl, {
          x: opts.x,
          y: opts.y,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("mouse moved");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("mouse-click")
    .description("Click at viewport coordinates")
    .option("--x <n>", "X coordinate", (v: string) => Number(v))
    .option("--y <n>", "Y coordinate", (v: string) => Number(v))
    .option("--button <left|right|middle>", "Mouse button")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      if (!Number.isFinite(opts.x) || !Number.isFinite(opts.y)) {
        defaultRuntime.error(danger("--x and --y are required"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserMouseClick(baseUrl, {
          x: opts.x,
          y: opts.y,
          button: opts.button?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("mouse clicked");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("mouse-drag")
    .description("Drag by viewport coordinates")
    .option("--start-x <n>", "Start X", (v: string) => Number(v))
    .option("--start-y <n>", "Start Y", (v: string) => Number(v))
    .option("--end-x <n>", "End X", (v: string) => Number(v))
    .option("--end-y <n>", "End Y", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      if (
        !Number.isFinite(opts.startX) ||
        !Number.isFinite(opts.startY) ||
        !Number.isFinite(opts.endX) ||
        !Number.isFinite(opts.endY)
      ) {
        defaultRuntime.error(
          danger("--start-x, --start-y, --end-x, --end-y are required"),
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserMouseDrag(baseUrl, {
          startX: opts.startX,
          startY: opts.startY,
          endX: opts.endX,
          endY: opts.endY,
          targetId: opts.targetId?.trim() || undefined,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("mouse dragged");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
