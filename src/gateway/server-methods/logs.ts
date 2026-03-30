import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { clamp } from "../../utils.js";
import { resolveUserPath } from "../../utils.js";
import { parseBooleanValue } from "../../utils/boolean.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLogsTailParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_LIMIT = 5000;
const MAX_BYTES = 1_000_000;
const ROLLING_LOG_RE = /^openclaw-\d{4}-\d{2}-\d{2}\.log$/;
type LogsSource = "gateway" | "llm";

function isRollingLogFile(file: string): boolean {
  return ROLLING_LOG_RE.test(path.basename(file));
}

async function resolveLogFile(file: string): Promise<string> {
  const stat = await fs.stat(file).catch(() => null);
  if (stat) {
    return file;
  }
  if (!isRollingLogFile(file)) {
    return file;
  }

  const dir = path.dirname(file);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return file;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && ROLLING_LOG_RE.test(entry.name))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const fileStat = await fs.stat(fullPath).catch(() => null);
        return fileStat ? { path: fullPath, mtimeMs: fileStat.mtimeMs } : null;
      }),
  );
  const sorted = candidates
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted[0]?.path ?? file;
}

function resolveLlmLogFile(): string {
  const config = loadConfig();
  const configuredFile = config.diagnostics?.cacheTrace?.filePath?.trim();
  const envFile = process.env.OPENCLAW_CACHE_TRACE_FILE?.trim();
  const filePath = configuredFile || envFile;
  return filePath
    ? resolveUserPath(filePath)
    : path.join(resolveStateDir(process.env), "logs", "cache-trace.jsonl");
}

async function resolveLogFileForSource(source: LogsSource): Promise<string> {
  if (source === "llm") {
    return resolveLlmLogFile();
  }
  return resolveLogFile(getResolvedLoggerSettings().file);
}

function isLlmSourceEnabled(): boolean {
  const config = loadConfig();
  const envEnabled = parseBooleanValue(process.env.OPENCLAW_CACHE_TRACE);
  return envEnabled ?? config.diagnostics?.cacheTrace?.enabled ?? false;
}

async function readLogSlice(params: {
  file: string;
  cursor?: number;
  limit: number;
  maxBytes: number;
}) {
  const stat = await fs.stat(params.file).catch(() => null);
  if (!stat) {
    return {
      cursor: 0,
      size: 0,
      lines: [] as string[],
      truncated: false,
      reset: false,
    };
  }

  const size = stat.size;
  const maxBytes = clamp(params.maxBytes, 1, MAX_BYTES);
  const limit = clamp(params.limit, 1, MAX_LIMIT);
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = false;
  let truncated = false;
  let start = 0;

  if (cursor != null) {
    if (cursor > size) {
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        reset = true;
        truncated = true;
        start = Math.max(0, size - maxBytes);
      }
    }
  } else {
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  if (size === 0 || size <= start) {
    return {
      cursor: size,
      size,
      lines: [] as string[],
      truncated,
      reset,
    };
  }

  const handle = await fs.open(params.file, "r");
  try {
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }

    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0 && prefix !== "\n") {
      lines = lines.slice(1);
    }
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }

    cursor = size;

    return {
      cursor,
      size,
      lines,
      truncated,
      reset,
    };
  } finally {
    await handle.close();
  }
}

export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": async ({ params, respond }) => {
    if (!validateLogsTailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as {
      cursor?: number;
      limit?: number;
      maxBytes?: number;
      source?: LogsSource;
    };
    const source: LogsSource = p.source ?? "gateway";
    try {
      const file = await resolveLogFileForSource(source);
      const result = await readLogSlice({
        file,
        cursor: p.cursor,
        limit: p.limit ?? DEFAULT_LIMIT,
        maxBytes: p.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      const hint =
        source === "llm" && !isLlmSourceEnabled()
          ? "LLM logs are disabled for the current gateway process. Enable diagnostics.cacheTrace.enabled=true or set OPENCLAW_CACHE_TRACE=1, restart the gateway, then reproduce the run. Existing cache-trace.jsonl contents may be historical."
          : undefined;
      respond(true, { file, source, ...result, hint }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`),
      );
    }
  },
};
