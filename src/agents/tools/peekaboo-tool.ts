import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./common.js";

const PEEKABOO_ACTIONS = [
  "status",
  "permissions",
  "open",
  "list_windows",
  "see",
  "image",
  "click",
  "type",
  "press",
  "hotkey",
  "scroll",
  "window_set_bounds",
] as const;

const PEEKABOO_IMAGE_FORMATS = ["png", "jpg"] as const;
const PEEKABOO_CAPTURE_MODES = ["auto", "screen", "window", "frontmost"] as const;
const PEEKABOO_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const PeekabooToolSchema = Type.Object({
  action: stringEnum(PEEKABOO_ACTIONS),
  timeoutMs: Type.Optional(Type.Number()),
  // target/app selectors
  app: Type.Optional(Type.String()),
  windowTitle: Type.Optional(Type.String()),
  windowId: Type.Optional(Type.Number()),
  screenIndex: Type.Optional(Type.Number()),
  mode: optionalStringEnum(PEEKABOO_CAPTURE_MODES),
  // open
  url: Type.Optional(Type.String()),
  waitUntilReady: Type.Optional(Type.Boolean()),
  noFocus: Type.Optional(Type.Boolean()),
  // capture
  path: Type.Optional(Type.String()),
  annotate: Type.Optional(Type.Boolean()),
  format: optionalStringEnum(PEEKABOO_IMAGE_FORMATS),
  retina: Type.Optional(Type.Boolean()),
  // interaction
  on: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  coords: Type.Optional(Type.String()),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  submit: Type.Optional(Type.Boolean()),
  key: Type.Optional(Type.String()),
  keys: Type.Optional(Type.String()),
  count: Type.Optional(Type.Number()),
  direction: optionalStringEnum(PEEKABOO_SCROLL_DIRECTIONS),
  amount: Type.Optional(Type.Number()),
  // window_set_bounds
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
});

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type RunResult = {
  ok: boolean;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  json?: unknown;
};

type PeekabooToolDeps = {
  execFile?: ExecFile;
  tmpDir?: string;
  platform?: NodeJS.Platform;
};

function clampTimeoutMs(raw?: number) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(raw)));
}

function makeTempPath(tmpDir: string, action: string, ext: string) {
  return path.join(tmpDir, `openclaw-peekaboo-${action}-${randomUUID()}.${ext}`);
}

function pushTargetArgs(args: string[], params: Record<string, unknown>) {
  const app = readStringParam(params, "app");
  if (app) {
    args.push("--app", app);
  }
  const windowTitle = readStringParam(params, "windowTitle");
  if (windowTitle) {
    args.push("--window-title", windowTitle);
  }
  const windowId = readNumberParam(params, "windowId", { integer: true });
  if (windowId !== undefined) {
    args.push("--window-id", String(windowId));
  }
  const screenIndex = readNumberParam(params, "screenIndex", { integer: true });
  if (screenIndex !== undefined) {
    args.push("--screen-index", String(screenIndex));
  }
}

function readCoords(params: Record<string, unknown>) {
  const coords = readStringParam(params, "coords");
  if (coords) {
    return coords;
  }
  const x = readNumberParam(params, "x");
  const y = readNumberParam(params, "y");
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return `${Math.round(x)},${Math.round(y)}`;
}

function parseMaybeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function pickImagePath(result: RunResult, fallbackPath?: string) {
  const obj =
    result.json && typeof result.json === "object" ? (result.json as Record<string, unknown>) : {};
  const data =
    obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : {};
  const candidates = [
    data.screenshot_annotated,
    data.screenshot_raw,
    data.path,
    obj.screenshot_annotated,
    obj.screenshot_raw,
    obj.path,
    fallbackPath,
  ];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}

export function buildPeekabooArgs(params: Record<string, unknown>, opts?: { tmpDir?: string }) {
  const action = readStringParam(params, "action", { required: true });
  const tmpDir = opts?.tmpDir ?? os.tmpdir();
  const args: string[] = [];
  let imagePath: string | undefined;

  switch (action) {
    case "status":
      args.push("--version");
      break;
    case "permissions":
      args.push("permissions", "--json");
      break;
    case "open": {
      const url = readStringParam(params, "url", { required: true });
      args.push("open", url);
      const app = readStringParam(params, "app");
      if (app) {
        args.push("--app", app);
      }
      if (params.waitUntilReady !== false) {
        args.push("--wait-until-ready");
      }
      if (params.noFocus === true) {
        args.push("--no-focus");
      }
      args.push("--json");
      break;
    }
    case "list_windows": {
      args.push("list", "windows");
      const app = readStringParam(params, "app");
      if (app) {
        args.push("--app", app);
      }
      args.push("--json");
      break;
    }
    case "see": {
      args.push("see");
      pushTargetArgs(args, params);
      const mode = readStringParam(params, "mode");
      if (mode && mode !== "auto") {
        args.push("--mode", mode);
      }
      if (params.annotate === true) {
        args.push("--annotate");
      }
      const outPath =
        readStringParam(params, "path") ??
        makeTempPath(tmpDir, "see", params.annotate === true ? "png" : "png");
      imagePath = outPath;
      args.push("--path", outPath, "--json");
      break;
    }
    case "image": {
      args.push("image");
      pushTargetArgs(args, params);
      const mode = readStringParam(params, "mode");
      if (mode && mode !== "auto") {
        args.push("--mode", mode);
      }
      const format = readStringParam(params, "format") ?? "png";
      const outPath = readStringParam(params, "path") ?? makeTempPath(tmpDir, "image", format);
      imagePath = outPath;
      args.push("--path", outPath, "--format", format);
      if (params.retina === true) {
        args.push("--retina");
      }
      args.push("--json");
      break;
    }
    case "click": {
      args.push("click");
      pushTargetArgs(args, params);
      const target = readStringParam(params, "on") ?? readStringParam(params, "id");
      const coords = readCoords(params);
      if (target) {
        args.push("--on", target);
      } else if (coords) {
        args.push("--coords", coords);
      } else {
        throw new Error("click requires on/id or coords/x+y");
      }
      break;
    }
    case "type": {
      const text = readStringParam(params, "text", { required: true, trim: false });
      args.push("type", text);
      pushTargetArgs(args, params);
      if (params.submit === true) {
        args.push("--return");
      }
      break;
    }
    case "press": {
      const key = readStringParam(params, "key", { required: true });
      args.push("press", key);
      pushTargetArgs(args, params);
      const count = readNumberParam(params, "count", { integer: true });
      if (count !== undefined) {
        args.push("--count", String(count));
      }
      break;
    }
    case "hotkey": {
      const keys = readStringParam(params, "keys", { required: true });
      args.push("hotkey", "--keys", keys);
      pushTargetArgs(args, params);
      break;
    }
    case "scroll": {
      const direction = readStringParam(params, "direction") ?? "down";
      const amount = readNumberParam(params, "amount", { integer: true }) ?? 5;
      args.push("scroll", "--direction", direction, "--amount", String(amount));
      pushTargetArgs(args, params);
      break;
    }
    case "window_set_bounds": {
      const width = readNumberParam(params, "width", { integer: true, required: true });
      const height = readNumberParam(params, "height", { integer: true, required: true });
      const x = readNumberParam(params, "x", { integer: true }) ?? 0;
      const y = readNumberParam(params, "y", { integer: true }) ?? 0;
      args.push(
        "window",
        "set-bounds",
        "--x",
        String(x),
        "--y",
        String(y),
        "--width",
        String(width),
        "--height",
        String(height),
      );
      pushTargetArgs(args, params);
      break;
    }
    default:
      throw new Error(`Unknown peekaboo action: ${action}`);
  }

  return { args, imagePath };
}

async function runPeekaboo(params: {
  execFile: ExecFile;
  args: string[];
  timeoutMs: number;
}): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    params.execFile(
      "peekaboo",
      params.args,
      { timeout: params.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        const result: RunResult = {
          ok: !error,
          command: "peekaboo",
          args: params.args,
          stdout,
          stderr,
          json: parseMaybeJson(stdout),
        };
        if (error) {
          reject(Object.assign(new Error(stderr.trim() || error.message), { result }));
          return;
        }
        resolve(result);
      },
    );
  });
}

export function createPeekabooTool(opts?: {
  config?: OpenClawConfig;
  deps?: PeekabooToolDeps;
}): AnyAgentTool {
  const execFile = opts?.deps?.execFile ?? (execFileCallback as ExecFile);
  const tmpDir = opts?.deps?.tmpDir ?? os.tmpdir();
  const platform = opts?.deps?.platform ?? process.platform;
  const imageSanitization = resolveImageSanitizationLimits(opts?.config);

  return {
    label: "Peekaboo",
    name: "peekaboo",
    description:
      "Use Peekaboo for fast macOS visual UI automation: native app/Safari screenshots, annotated UI maps, clicks, typing, scrolling, and window control. Prefer browser for structured DOM extraction/forms; prefer peekaboo when a real macOS screen view is more accurate or faster than browser snapshots/vision-heavy loops.",
    parameters: PeekabooToolSchema,
    execute: async (_toolCallId, args) => {
      if (platform !== "darwin") {
        throw new Error("Peekaboo is only available on macOS.");
      }
      const params = args as Record<string, unknown>;
      const { args: peekabooArgs, imagePath } = buildPeekabooArgs(params, { tmpDir });
      const result = await runPeekaboo({
        execFile,
        args: peekabooArgs,
        timeoutMs: clampTimeoutMs(
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : undefined,
        ),
      });

      const action = readStringParam(params, "action", { required: true });
      if (action === "see" || action === "image") {
        const resolvedImagePath = pickImagePath(result, imagePath);
        if (resolvedImagePath) {
          const exists = await fs
            .stat(resolvedImagePath)
            .then((stat) => stat.isFile())
            .catch(() => false);
          if (exists) {
            return await imageResultFromFile({
              label: `peekaboo:${action}`,
              path: resolvedImagePath,
              details: {
                ok: true,
                action,
                path: resolvedImagePath,
                result: result.json ?? result.stdout.trim(),
              },
              imageSanitization,
            });
          }
        }
      }

      return jsonResult({
        ok: true,
        action,
        command: result.command,
        args: result.args,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        ...(result.json !== undefined ? { result: result.json } : {}),
      });
    },
  };
}
