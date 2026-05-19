import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexCliOptions {
  model?: string;
  contextFile?: string;
  outputSchema?: object;
  timeoutMs?: number;
}

export interface CodexCliEvent {
  type:
    | "turn.started"
    | "turn.completed"
    | "turn.failed"
    | "item.started"
    | "item.updated"
    | "item.completed";
  payload?: unknown;
}

export interface CodexCliResult {
  result: string;
  events: CodexCliEvent[];
  durationMs: number;
  rawOutput: string;
}

function parseJsonlEvents(raw: string): CodexCliEvent[] {
  const events: CodexCliEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexCliEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

function extractResult(events: CodexCliEvent[]): string {
  const completed = events.find((e) => e.type === "turn.completed");
  if (!completed) return "";
  if (typeof completed.payload === "string") return completed.payload;
  if (completed.payload != null && typeof completed.payload === "object") {
    const p = completed.payload as Record<string, unknown>;
    return String(p["result"] ?? p["output"] ?? JSON.stringify(p));
  }
  return "";
}

export async function callCodexCli(
  task: string,
  opts: CodexCliOptions = {},
): Promise<CodexCliResult> {
  const model = opts.model ?? "gpt-5.5";
  const timeout = opts.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  const args: string[] = ["exec", "--model", model, "--json", task];

  let tmpFile: string | undefined;
  let rawOutput = "";

  try {
    if (opts.contextFile) {
      tmpFile = path.join(os.tmpdir(), `codex_ctx_${crypto.randomUUID()}.txt`);
      await fs.copyFile(opts.contextFile, tmpFile);
    }

    const { stdout } = await execFileAsync("codex", args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    rawOutput = stdout;

    const events = parseJsonlEvents(rawOutput);
    const result = extractResult(events);
    const durationMs = Date.now() - startedAt;

    return { result, events, durationMs, rawOutput };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("請確認 codex CLI 已安裝：npm install -g @openai/codex");
    }
    throw err;
  } finally {
    if (tmpFile) {
      await fs.unlink(tmpFile).catch(() => undefined);
    }
  }
}
