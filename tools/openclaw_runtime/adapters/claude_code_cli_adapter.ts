import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeCliOptions {
  model?: "sonnet" | "haiku" | "opus";
  systemPrompt?: string;
  contextJson?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface ClaudeCliResult {
  result: string;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  numTurns: number;
  rawOutput: string;
}

interface ClaudeJsonOutput {
  type: string;
  subtype?: string;
  result: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  session_id?: string;
}

export async function callClaudeCli(
  task: string,
  opts: ClaudeCliOptions = {},
): Promise<ClaudeCliResult> {
  const prompt = opts.contextJson ? `${task}\n\n[context_json]\n${opts.contextJson}` : task;
  const args: string[] = ["-p", prompt, "--output-format", "json"];

  if (opts.model) args.push("--model", opts.model);
  if (opts.systemPrompt) args.push("--system", opts.systemPrompt);
  if (opts.maxTurns != null) args.push("--max-turns", String(opts.maxTurns));

  const timeout = opts.timeoutMs ?? 120_000;
  let rawOutput = "";

  try {
    const { stdout } = await execFileAsync("claude", args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    rawOutput = stdout;

    let parsed: ClaudeJsonOutput;
    try {
      parsed = JSON.parse(rawOutput) as ClaudeJsonOutput;
    } catch {
      throw new Error(`[claude_code_cli_adapter] JSON parse failed. rawOutput: ${rawOutput}`);
    }

    return {
      result: parsed.result,
      costUsd: parsed.total_cost_usd ?? 0,
      durationMs: parsed.duration_ms ?? 0,
      sessionId: parsed.session_id ?? "",
      numTurns: parsed.num_turns ?? 0,
      rawOutput,
    };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("請確認 claude CLI 已安裝：npm install -g @anthropic-ai/claude-code");
    }
    if (rawOutput) {
      throw new Error(
        `[claude_code_cli_adapter] CLI error. rawOutput: ${rawOutput}\n${String(err)}`,
      );
    }
    throw err;
  }
}
