import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { runCommandWithTimeout } from "../../process/exec.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const APP_CONTROL_ACTIONS = ["open", "tail_log", "open_and_tail"] as const;

const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_FOLLOW_MS = 0;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_WAIT_FOR_LOG_MS = 0;

const APP_ALIASES = new Map<string, string>([
  ["cursor", "Cursor"],
  ["trae", "Trae"],
]);

const AppControlSchema = Type.Object({
  action: stringEnum(APP_CONTROL_ACTIONS),
  app: Type.Optional(Type.String()),
  logPath: Type.Optional(Type.String()),
  tailLines: Type.Optional(Type.Number()),
  maxBytes: Type.Optional(Type.Number()),
  followMs: Type.Optional(Type.Number()),
  intervalMs: Type.Optional(Type.Number()),
  waitForLogMs: Type.Optional(Type.Number()),
});

function resolveAppTarget(value: string): { kind: "path" | "name"; value: string } {
  const trimmed = value.trim();
  if (trimmed.includes(path.sep) || trimmed.endsWith(".app")) {
    return { kind: "path", value: trimmed };
  }
  const normalized = trimmed.toLowerCase();
  const mapped = APP_ALIASES.get(normalized);
  return { kind: "name", value: mapped ?? trimmed };
}

async function openApp(app: string): Promise<{ ok: boolean; app: string; command: string[] }> {
  if (process.platform !== "darwin") {
    throw new Error("app_control: open is only supported on macOS right now.");
  }
  const target = resolveAppTarget(app);
  const command = target.kind === "path" ? ["open", target.value] : ["open", "-a", target.value];
  await runCommandWithTimeout(command, 10_000);
  return { ok: true, app: target.value, command };
}

async function readLogSlice(params: {
  file: string;
  cursor?: number;
  maxBytes: number;
}): Promise<{ exists: boolean; cursor: number; lines: string[] }> {
  const stat = await fs.stat(params.file).catch(() => null);
  if (!stat) {
    return { exists: false, cursor: 0, lines: [] };
  }
  const size = stat.size;
  const maxBytes = Math.max(1, params.maxBytes);
  const start =
    typeof params.cursor === "number" && params.cursor >= 0 && params.cursor < size
      ? params.cursor
      : Math.max(0, size - maxBytes);
  const handle = await fs.open(params.file, "r");
  try {
    const length = Math.max(0, size - start);
    if (length === 0) {
      return { exists: true, cursor: size, lines: [] };
    }
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0) {
      lines = lines.slice(1);
    }
    if (lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    return { exists: true, cursor: size, lines };
  } finally {
    await handle.close();
  }
}

async function waitForLogFile(file: string, waitMs: number): Promise<boolean> {
  if (waitMs <= 0) {
    return (await fs.stat(file).catch(() => null)) !== null;
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await fs.stat(file).catch(() => null)) !== null) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return (await fs.stat(file).catch(() => null)) !== null;
}

async function tailLog(params: {
  file: string;
  tailLines: number;
  maxBytes: number;
  followMs: number;
  intervalMs: number;
  waitForLogMs: number;
}): Promise<{
  ok: boolean;
  exists: boolean;
  file: string;
  cursor: number;
  lines: string[];
  followedMs: number;
}> {
  const exists = await waitForLogFile(params.file, params.waitForLogMs);
  if (!exists) {
    return {
      ok: false,
      exists: false,
      file: params.file,
      cursor: 0,
      lines: [],
      followedMs: 0,
    };
  }
  const maxBytes = Math.max(1, params.maxBytes);
  const tailLines = Math.max(1, params.tailLines);
  const intervalMs = Math.max(100, params.intervalMs);
  const slice = await readLogSlice({ file: params.file, maxBytes });
  const initialLines =
    slice.lines.length > tailLines
      ? slice.lines.slice(slice.lines.length - tailLines)
      : slice.lines;
  let cursor = slice.cursor;
  let lines = [...initialLines];
  let followedMs = 0;
  const followMs = Math.max(0, params.followMs);
  while (followedMs < followMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    followedMs = Math.min(followMs, followedMs + intervalMs);
    const next = await readLogSlice({ file: params.file, cursor, maxBytes });
    cursor = next.cursor;
    if (next.lines.length > 0) {
      lines = lines.concat(next.lines);
    }
  }
  return { ok: true, exists: true, file: params.file, cursor, lines, followedMs };
}

export function createAppControlTool(): AnyAgentTool {
  return {
    label: "App Control",
    name: "app_control",
    description:
      "Open local apps and tail their log output. Use open/open_and_tail on macOS; use tail_log to read a log file and optionally follow it for a short window.",
    parameters: AppControlSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const app = readStringParam(params, "app");
      const logPath = readStringParam(params, "logPath");
      const tailLines =
        readNumberParam(params, "tailLines", { integer: true }) ?? DEFAULT_TAIL_LINES;
      const maxBytes = readNumberParam(params, "maxBytes", { integer: true }) ?? DEFAULT_MAX_BYTES;
      const followMs = readNumberParam(params, "followMs", { integer: true }) ?? DEFAULT_FOLLOW_MS;
      const intervalMs =
        readNumberParam(params, "intervalMs", { integer: true }) ?? DEFAULT_INTERVAL_MS;
      const waitForLogMs =
        readNumberParam(params, "waitForLogMs", { integer: true }) ?? DEFAULT_WAIT_FOR_LOG_MS;

      if (action === "open") {
        if (!app) {
          throw new Error("app required");
        }
        const result = await openApp(app);
        return jsonResult({ action, ...result });
      }

      if (action === "tail_log") {
        if (!logPath) {
          throw new Error("logPath required");
        }
        const resolved = path.resolve(logPath);
        const log = await tailLog({
          file: resolved,
          tailLines,
          maxBytes,
          followMs,
          intervalMs,
          waitForLogMs,
        });
        return jsonResult({ action, log });
      }

      if (action === "open_and_tail") {
        if (!app) {
          throw new Error("app required");
        }
        if (!logPath) {
          throw new Error("logPath required");
        }
        const opened = await openApp(app);
        const resolved = path.resolve(logPath);
        const log = await tailLog({
          file: resolved,
          tailLines,
          maxBytes,
          followMs,
          intervalMs,
          waitForLogMs,
        });
        return jsonResult({ action, ...opened, log });
      }

      throw new Error(`unsupported action: ${action}`);
    },
  };
}
