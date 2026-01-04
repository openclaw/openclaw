import type { Command } from "commander";
import { resolveBrowserControlUrl } from "../browser/client.js";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserNavigate,
} from "../browser/client-actions.js";
import type { BrowserFormField } from "../browser/client-actions-core.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

async function readFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return await fs.readFile(path, "utf8");
}

async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFormField[]> {
  const payload = opts.fieldsFile
    ? await readFile(opts.fieldsFile)
    : (opts.fields ?? "");
  if (!payload.trim()) throw new Error("fields are required");
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) throw new Error("fields must be an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`fields[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    const ref = typeof rec.ref === "string" ? rec.ref.trim() : "";
    const type = typeof rec.type === "string" ? rec.type.trim() : "";
    if (!ref || !type) {
      throw new Error(`fields[${index}] must include ref and type`);
    }
    if (
      typeof rec.value === "string" ||
      typeof rec.value === "number" ||
      typeof rec.value === "boolean"
    ) {
      return { ref, type, value: rec.value };
    }
    if (rec.value === undefined || rec.value === null) {
      return { ref, type };
    }
    throw new Error(
      `fields[${index}].value must be string, number, boolean, or null`,
    );
  });
}

export function registerBrowserActionInputCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (url: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserNavigate(baseUrl, {
          url,
          targetId: opts.targetId?.trim() || undefined,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`navigated to ${result.url ?? url}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("resize")
    .description("Resize the viewport")
    .argument("<width>", "Viewport width", (v: string) => Number(v))
    .argument("<height>", "Viewport height", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: number, height: number, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        defaultRuntime.error(danger("width and height must be numbers"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserAct(baseUrl, {
          kind: "resize",
          width,
          height,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`resized to ${width}x${height}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("click")
    .description("Click an element by ref from snapshot")
    .argument("<ref>", "Ref id from ai snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use")
    .option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)")
    .action(async (ref: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      const refValue = typeof ref === "string" ? ref.trim() : "";
      if (!refValue) {
        defaultRuntime.error(danger("ref is required"));
        defaultRuntime.exit(1);
        return;
      }
      const modifiers = opts.modifiers
        ? String(opts.modifiers)
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean)
        : undefined;
      try {
        const result = await browserAct(baseUrl, {
          kind: "click",
          ref: refValue,
          targetId: opts.targetId?.trim() || undefined,
          doubleClick: Boolean(opts.double),
          button: opts.button?.trim() || undefined,
          modifiers,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const suffix = result.url ? ` on ${result.url}` : "";
        defaultRuntime.log(`clicked ref ${refValue}${suffix}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("type")
    .description("Type into an element by ref from snapshot")
    .argument("<ref>", "Ref id from ai snapshot")
    .argument("<text>", "Text to type")
    .option("--submit", "Press Enter after typing", false)
    .option("--slowly", "Type slowly (human-like)", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string | undefined, text: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      const refValue = typeof ref === "string" ? ref.trim() : "";
      if (!refValue) {
        defaultRuntime.error(danger("ref is required"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserAct(baseUrl, {
          kind: "type",
          ref: refValue,
          text,
          submit: Boolean(opts.submit),
          slowly: Boolean(opts.slowly),
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`typed into ref ${refValue}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("press")
    .description("Press a key")
    .argument("<key>", "Key to press (e.g. Enter)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (key: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserAct(baseUrl, {
          kind: "press",
          key,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`pressed ${key}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("hover")
    .description("Hover an element by ai ref")
    .argument("<ref>", "Ref id from ai snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserAct(baseUrl, {
          kind: "hover",
          ref,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`hovered ref ${ref}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("drag")
    .description("Drag from one ref to another")
    .argument("<startRef>", "Start ref id")
    .argument("<endRef>", "End ref id")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (startRef: string, endRef: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserAct(baseUrl, {
          kind: "drag",
          startRef,
          endRef,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`dragged ${startRef} → ${endRef}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("select")
    .description("Select option(s) in a select element")
    .argument("<ref>", "Ref id from ai snapshot")
    .argument("<values...>", "Option values to select")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, values: string[], opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserAct(baseUrl, {
          kind: "select",
          ref,
          values,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`selected ${values.join(", ")}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("upload")
    .description("Arm file upload for the next file chooser")
    .argument("<paths...>", "File paths to upload")
    .option("--ref <ref>", "Ref id from ai snapshot to click after arming")
    .option("--input-ref <ref>", "Ref id for <input type=file> to set directly")
    .option("--element <selector>", "CSS selector for <input type=file>")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next file chooser (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (paths: string[], opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserArmFileChooser(baseUrl, {
          paths,
          ref: opts.ref?.trim() || undefined,
          inputRef: opts.inputRef?.trim() || undefined,
          element: opts.element?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
          timeoutMs: Number.isFinite(opts.timeoutMs)
            ? opts.timeoutMs
            : undefined,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`upload armed for ${paths.length} file(s)`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("fill")
    .description("Fill a form with JSON field descriptors")
    .option("--fields <json>", "JSON array of field objects")
    .option("--fields-file <path>", "Read JSON array from a file")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const fields = await readFields({
          fields: opts.fields,
          fieldsFile: opts.fieldsFile,
        });
        const result = await browserAct(baseUrl, {
          kind: "fill",
          fields,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`filled ${fields.length} field(s)`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("dialog")
    .description("Arm the next modal dialog (alert/confirm/prompt)")
    .option("--accept", "Accept the dialog", false)
    .option("--dismiss", "Dismiss the dialog", false)
    .option("--prompt <text>", "Prompt response text")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next dialog (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      const accept = opts.accept ? true : opts.dismiss ? false : undefined;
      if (accept === undefined) {
        defaultRuntime.error(danger("Specify --accept or --dismiss"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserArmDialog(baseUrl, {
          accept,
          promptText: opts.prompt?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
          timeoutMs: Number.isFinite(opts.timeoutMs)
            ? opts.timeoutMs
            : undefined,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("dialog armed");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("wait")
    .description("Wait for time or text conditions")
    .option("--time <ms>", "Wait for N milliseconds", (v: string) => Number(v))
    .option("--text <value>", "Wait for text to appear")
    .option("--text-gone <value>", "Wait for text to disappear")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      try {
        const result = await browserAct(baseUrl, {
          kind: "wait",
          timeMs: Number.isFinite(opts.time) ? opts.time : undefined,
          text: opts.text?.trim() || undefined,
          textGone: opts.textGone?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("wait complete");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("evaluate")
    .description("Evaluate a function against the page or a ref")
    .option("--fn <code>", "Function source, e.g. (el) => el.textContent")
    .option("--ref <id>", "ARIA ref from ai snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.profile;
      if (!opts.fn) {
        defaultRuntime.error(danger("Missing --fn"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserAct(baseUrl, {
          kind: "evaluate",
          fn: opts.fn,
          ref: opts.ref?.trim() || undefined,
          targetId: opts.targetId?.trim() || undefined,
        }, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(JSON.stringify(result.result ?? null, null, 2));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
