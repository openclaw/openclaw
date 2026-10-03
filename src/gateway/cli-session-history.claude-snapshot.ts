import fs from "node:fs";
import readline from "node:readline";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import type { CliSessionReseedReceipt } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import { createCpuTrackedWorker } from "../infra/worker-cpu.js";
import {
  appendCoalescedClaudeCliToolMessage,
  createClaudeReseedImportState,
  decodeClaudeCliProjectEntry,
  type ClaudeCliProjectEntry,
  parseClaudeCliHistoryEntry,
  redactClaudeCliHistoryMessage,
  resolveClaudeCliSessionFilePathAsync,
} from "./cli-session-history.claude.js";

const YIELD_BYTES = 256 * 1024;
const OFFTHREAD_JSONL_LINE_CHARS = 1024 * 1024;
const OVERSIZED_HISTORY_PLACEHOLDER =
  "[Claude CLI history record omitted from context because it exceeded 1 MiB.]";
const OVERSIZED_ENTRY_WORKER_SOURCE = `
  const { parentPort } = require("node:worker_threads");
  const boundedString = (value, max) =>
    typeof value === "string" && value.length <= max ? value : undefined;
  parentPort.on("message", (line) => {
    try {
      const entry = JSON.parse(line);
      const type = entry?.type;
      const message = entry?.message;
      if ((type !== "user" && type !== "assistant") || !message || message.role !== type) {
        parentPort.postMessage(null);
      } else {
        const rawUsage = message.usage;
        const usage = rawUsage && typeof rawUsage === "object"
          ? Object.fromEntries(
              ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                .flatMap((key) => Number.isFinite(rawUsage[key]) ? [[key, rawUsage[key]]] : []),
            )
          : undefined;
        parentPort.postMessage({
          type,
          timestamp: boundedString(entry.timestamp, 128),
          uuid: boundedString(entry.uuid, 1_024),
          isSidechain: entry.isSidechain === true,
          isMeta: entry.isMeta === true,
          isCompactSummary: entry.isCompactSummary === true,
          isVisibleInTranscriptOnly: entry.isVisibleInTranscriptOnly === true,
          message: {
            role: type,
            content: ${JSON.stringify(OVERSIZED_HISTORY_PLACEHOLDER)},
            model: boundedString(message.model, 256),
            stop_reason: boundedString(message.stop_reason, 128),
            usage,
          },
        });
      }
    } catch {
      parentPort.postMessage(null);
    }
  });
`;
type Message = Record<string, unknown>;
export type ClaudeCliHistoryParams = {
  cliSessionId: string;
  homeDir?: string;
  localSessionId?: string;
  reseedReceipt?: CliSessionReseedReceipt;
};
async function decodeOversizedClaudeEntry(
  worker: Worker,
  line: string,
): Promise<ClaudeCliProjectEntry | null> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: ClaudeCliProjectEntry | null) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.off("message", finish);
      worker.off("error", fail);
      worker.off("exit", fail);
      resolve(value);
    };
    const fail = () => finish(null);
    worker.once("message", finish);
    worker.once("error", fail);
    worker.once("exit", fail);
    try {
      worker.postMessage(line, []);
    } catch {
      fail();
    }
  });
}

function fingerprint(stats: fs.Stats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

export async function resolveClaudeCliHistorySource(
  params: ClaudeCliHistoryParams,
): Promise<readonly [filePath: string, cacheKey: string, byteLength: number] | undefined> {
  const candidate = await resolveClaudeCliSessionFilePathAsync(params);
  if (!candidate) {
    return undefined;
  }
  try {
    const filePath = await fs.promises.realpath(candidate);
    const stats = await fs.promises.stat(filePath);
    const sourceFingerprint = fingerprint(stats);
    const cacheKey = JSON.stringify([
      filePath,
      sourceFingerprint,
      params.cliSessionId,
      params.localSessionId?.trim() || null,
      normalizeCliSessionReseedReceipt(params.reseedReceipt),
    ]);
    return [filePath, cacheKey, stats.size];
  } catch {
    return undefined;
  }
}

export async function visitClaudeCliSessionMessages(
  filePath: string,
  params: ClaudeCliHistoryParams,
  visit: (message: Message) => void,
  byteLength?: number,
): Promise<void> {
  if (byteLength === 0) {
    return;
  }
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, {
      encoding: "utf8",
      ...(byteLength === undefined ? {} : { end: byteLength - 1 }),
    }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const reseedState = createClaudeReseedImportState(params);
  let bytesSinceYield = 0;
  let lineNumber = 0;
  let worker: Worker | undefined;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const oversized = line.length > OFFTHREAD_JSONL_LINE_CHARS;
      if (oversized) {
        bytesSinceYield = 0;
      } else {
        bytesSinceYield += Buffer.byteLength(line, "utf8") + 1;
        if (bytesSinceYield >= YIELD_BYTES) {
          bytesSinceYield = 0;
          await yieldToEventLoop();
        }
        if (!line.trim()) {
          continue;
        }
      }
      let parsedMessage: Message | null = null;
      try {
        // Keep large valid user/assistant records visible through a bounded projection;
        // unsupported external records are still ignored, but JSON.parse runs off-loop.
        let entry: ClaudeCliProjectEntry | null;
        if (oversized) {
          if (!worker || worker.threadId === -1) {
            worker = createCpuTrackedWorker(OVERSIZED_ENTRY_WORKER_SOURCE, { eval: true });
            // Isolate failures between records remain local to this history import.
            worker.on("error", () => {});
          }
          entry = await decodeOversizedClaudeEntry(worker, line);
        } else {
          entry = decodeClaudeCliProjectEntry(line);
        }
        if (!entry) {
          continue;
        }
        parsedMessage = parseClaudeCliHistoryEntry(
          entry,
          params.cliSessionId,
          lineNumber,
          toolNames,
          { reseedMode: "recover", reseedState },
        );
      } catch {
        // Ignore malformed external history entries.
      }
      if (parsedMessage) {
        appendCoalescedClaudeCliToolMessage(messages, parsedMessage);
        if (messages.length > 1) {
          visit(redactClaudeCliHistoryMessage(messages.shift()!));
        }
      }
    }
  } finally {
    await worker?.terminate();
  }
  for (const message of messages) {
    visit(redactClaudeCliHistoryMessage(message));
  }
}
