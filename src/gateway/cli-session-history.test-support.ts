import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hashCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";
import {
  resolveClaudeCliHistorySource,
  visitClaudeCliSessionMessages,
  type ClaudeCliHistoryParams,
} from "./cli-session-history.claude-snapshot.js";

// Preserve saved transcript bytes independently of the retired exec prompt builder.
export const LEGACY_EXEC_COMPLETION_PROMPT =
  "An async command you ran earlier has completed. The command completion details are:\n\n" +
  "Exec completed (example, code 0) :: done\n\n" +
  "Treat this completion as an internal continuation, not a new user request. " +
  "Reconcile it with the conversation and continue any outstanding authorized work. " +
  "Notify the user only if this provides a requested result not yet delivered, a meaningful change to the outcome, " +
  "or a new unresolved failure, blocker, or decision they need to know about. " +
  "Stay silent for routine output, duplicate or superseded results, and failures already recovered from; " +
  "do not recap them or announce that nothing changed. " +
  "If no user-facing update is needed, reply with exactly NO_REPLY as the entire final answer. " +
  "NO_REPLY discards anything written this turn that was not sent, so send confirmations before ending silently.";

export async function readClaudeCliSessionMessagesAsync(
  params: ClaudeCliHistoryParams,
): Promise<Record<string, unknown>[]> {
  const source = await resolveClaudeCliHistorySource(params);
  const messages: Record<string, unknown>[] = [];
  if (source) {
    const [file, , bytes] = source;
    await visitClaudeCliSessionMessages(file, params, (message) => messages.push(message), bytes);
  }
  return messages;
}

export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  const index = new CliSessionHistoryIndex();
  try {
    index.appendLocal(
      params.localMessages.map((message, position) => ({ message, seq: position + 1 })),
    );
    for (const message of params.importedMessages) {
      index.appendImported(message);
    }
    index.finish();
    return Array.from(index.rows(0, index.count), (row) => {
      const message =
        row.local_seq === null ? index.message(row.id) : params.localMessages[row.local_seq - 1];
      const record = asOptionalRecord(message);
      return record
        ? { ...record, ...(row.metadata ? { __openclaw: JSON.parse(row.metadata) } : {}) }
        : message;
    });
  } finally {
    index.close();
  }
}
export function cliMeta(externalId: string, cliSessionId: string | null = "session-1") {
  const binding = cliSessionId === null ? {} : { cliSessionId };
  return { importedFrom: "claude-cli", externalId, ...binding };
}

export function answer(
  timestamp?: number,
  externalId?: string,
  cliSessionId: string | null = "session-1",
) {
  const meta = externalId === undefined ? undefined : cliMeta(externalId, cliSessionId);
  return { ...user("Repeated answer", timestamp, meta), role: "assistant" };
}

export function boundEntry(sessionId: string): SessionEntry {
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId } },
  };
}

export function receipt(prompt: string, sessionId = "openclaw-session"): CliSessionReseedReceipt {
  return {
    version: 1,
    promptHash: hashCliReseedPrompt(prompt),
    localSessionId: sessionId,
    userTurnDisposition: "persisted",
  };
}

export function user(content: unknown, timestamp?: number, meta?: Record<string, unknown>) {
  return {
    role: "user",
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(meta ? { __openclaw: meta } : {}),
  };
}

export function claudeUser(content: unknown, fields: Record<string, unknown> = {}) {
  return { type: "user", ...fields, message: { role: "user", content } };
}

export function createClaudeTextHistoryLines(
  entries: Array<{ content: string; role: "assistant" | "user"; uuid: string }>,
): string {
  return entries
    .map((entry, index) =>
      JSON.stringify({
        type: entry.role,
        uuid: entry.uuid,
        timestamp: new Date(Date.parse("2026-03-26T16:29:54.800Z") + index).toISOString(),
        message: { role: entry.role, content: entry.content },
      }),
    )
    .join("\n");
}

type ClaudeHistoryReadOptions = Omit<ClaudeCliHistoryParams, "cliSessionId" | "homeDir">;

export function withClaudeProjectsDir<T>(
  run: (params: {
    homeDir: string;
    sessionId: string;
    filePath: string;
    readMessages: (options?: ClaudeHistoryReadOptions) => Promise<Record<string, unknown>[]>;
  }) => Promise<T>,
): Promise<T> {
  return withTempDir("openclaw-claude-history-", async (root) => {
    const homeDir = path.join(root, "home");
    const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
    const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
    const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(filePath, createClaudeHistoryLines(), "utf-8");
    return withEnvAsync({ HOME: homeDir }, () =>
      run({
        homeDir,
        sessionId,
        filePath,
        readMessages: (options) =>
          readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir, ...options }),
      }),
    );
  });
}

export function buildLegacyReseedPrompt(current = "current"): string {
  return `Continue this conversation using the OpenClaw transcript below as prior session history.
Treat it as authoritative context for this fresh CLI session.

<conversation_history>
User: previous
</conversation_history>

<next_user_message>
${current}
</next_user_message>`;
}

function createClaudeHistoryLines() {
  const message = (
    role: "user" | "assistant",
    id: number,
    time: string,
    fields: Record<string, unknown>,
  ) => ({
    type: role,
    uuid: `${role}-${id}`,
    timestamp: `2026-03-26T16:29:${time}Z`,
    message: { role, ...fields },
  });
  return [
    { type: "queue-operation" },
    message("user", 1, "54.800", {
      content:
        'Sender: ⟦openclaw:ctx⟧\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
    }),
    message("assistant", 1, "55.500", {
      content: [{ type: "text", text: "hello from Claude" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 22 },
    }),
    message("assistant", 2, "56.000", {
      content: [{ type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "pwd" } }],
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
    }),
    message("user", 2, "56.400", {
      content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "/tmp/demo" }],
    }),
    { type: "last-prompt" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}
