import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { chunkTextWithMode, resolveChunkMode, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveKeybaseAccount } from "./accounts.js";
import { createKeybaseEventHandler, type KeybaseMessage } from "./monitor/event-handler.js";
import { sendMessageKeybase } from "./send.js";

export type MonitorKeybaseOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  config?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
};

function normalizeAllowList(raw?: Array<string | number>): string[] {
  return (raw ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

async function detectBotUsername(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("keybase", ["whoami"]);
  return stdout.trim();
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  runtime: RuntimeEnv;
  textLimit: number;
  chunkMode: "length" | "newline";
}) {
  const { replies, target, runtime, textLimit, chunkMode } = params;
  for (const payload of replies) {
    const text = payload.text ?? "";
    if (!text.trim()) {
      continue;
    }
    for (const chunk of chunkTextWithMode(text, textLimit, chunkMode)) {
      await sendMessageKeybase(target, chunk);
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

export async function monitorKeybaseProvider(opts: MonitorKeybaseOpts = {}): Promise<void> {
  const runtime = opts.runtime ?? createNonExitingRuntime();
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveKeybaseAccount({
    cfg,
    accountId: opts.accountId,
  });
  const historyLimit = Math.max(
    0,
    accountInfo.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "keybase", accountInfo.accountId);
  const chunkMode = resolveChunkMode(cfg, "keybase", accountInfo.accountId);
  const dmPolicy = accountInfo.config.dmPolicy ?? "pairing";
  const allowFrom = normalizeAllowList(opts.allowFrom ?? accountInfo.config.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      accountInfo.config.groupAllowFrom ??
      (accountInfo.config.allowFrom && accountInfo.config.allowFrom.length > 0
        ? accountInfo.config.allowFrom
        : []),
  );
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = accountInfo.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  // Detect the bot's own username for self-message filtering
  let botUsername: string;
  try {
    botUsername = await detectBotUsername();
    runtime.log?.(`keybase: logged in as ${botUsername}`);
  } catch (err) {
    throw new Error(`keybase: failed to detect username: ${String(err)}`, { cause: err });
  }

  const handleEvent = createKeybaseEventHandler({
    runtime,
    cfg,
    accountId: accountInfo.accountId,
    botUsername,
    blockStreaming: accountInfo.config.blockStreaming,
    historyLimit,
    groupHistories,
    textLimit,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    groupPolicy,
    deliverReplies: (params) => deliverReplies({ ...params, chunkMode }),
  });

  // Spawn keybase chat api-listen process
  const proc = spawn("keybase", ["chat", "api-listen"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onAbort = () => {
    proc.kill();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  // Log stderr
  if (proc.stderr) {
    const stderrRl = readline.createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        runtime.error?.(`keybase stderr: ${trimmed}`);
      }
    });
  }

  // Read stdout line by line
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const event = JSON.parse(trimmed) as KeybaseMessage;
      void handleEvent(event).catch((err) => {
        runtime.error?.(`keybase event handler failed: ${String(err)}`);
      });
    } catch (err) {
      runtime.error?.(`keybase: failed to parse event: ${String(err)}`);
    }
  });

  runtime.log?.("keybase: listening for messages via api-listen");

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("exit", (code) => {
        if (opts.abortSignal?.aborted) {
          resolve();
        } else {
          reject(new Error(`keybase chat api-listen exited with code ${code}`));
        }
      });
      proc.on("error", (err) => {
        reject(new Error(`keybase chat api-listen failed to start: ${String(err)}`));
      });
    });
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    try {
      proc.kill();
    } catch {
      // Already dead
    }
  }
}
