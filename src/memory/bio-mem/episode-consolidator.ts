import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { EpisodeEvent } from "./types.js";
import type { EmbeddingProvider } from "../embeddings.js";

type RawLine = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: string[]; // tool names used
};

// Parse JSONL session file into simple role/content lines
async function parseSessionMessages(sessionFile: string): Promise<RawLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionFile, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const result: RawLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }
    const r = record as Record<string, unknown>;
    if (r["type"] !== "message") {
      continue;
    }
    const message = r["message"] as Record<string, unknown> | undefined;
    if (!message || typeof message["role"] !== "string") {
      continue;
    }
    const role = message["role"];
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const content = message["content"];
    const toolCalls: string[] = [];
    let text = "";

    if (typeof content === "string") {
      text = content.trim();
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          parts.push((b["text"] as string).trim());
        } else if (b["type"] === "tool_use" && typeof b["name"] === "string") {
          toolCalls.push(b["name"] as string);
        }
      }
      text = parts.join(" ");
    }

    if (text || toolCalls.length > 0) {
      result.push({ role: role as "user" | "assistant", content: text, toolCalls });
    }
  }
  return result;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 1) + "…";
}

function extractEpisodeFields(lines: RawLine[]): {
  user_intent: string;
  action_taken: string;
  outcome: string;
} | null {
  if (lines.length === 0) {
    return null;
  }

  // user_intent: first user message
  const firstUser = lines.find((l) => l.role === "user");
  if (!firstUser) {
    return null;
  }
  const user_intent = truncate(firstUser.content || "(no text)", 200);

  // action_taken: collect unique tool calls, then assistant text summaries
  const allTools = lines.flatMap((l) => l.toolCalls ?? []);
  const uniqueTools = [...new Set(allTools)];
  let action_taken: string;
  if (uniqueTools.length > 0) {
    const toolSummary = uniqueTools.join(", ");
    const firstAssistantText = lines.find(
      (l) => l.role === "assistant" && l.content,
    )?.content;
    action_taken = firstAssistantText
      ? `Used ${toolSummary}; ${truncate(firstAssistantText, 120)}`
      : `Used ${toolSummary}`;
  } else {
    const firstAssistant = lines.find((l) => l.role === "assistant");
    action_taken = truncate(firstAssistant?.content || "(no action)", 200);
  }

  // outcome: last assistant message
  const lastAssistant = lines.filter((l) => l.role === "assistant").at(-1);
  const outcome = truncate(lastAssistant?.content || "(no outcome)", 200);

  return { user_intent, action_taken, outcome };
}

export type ConsolidateParams = {
  sessionFile: string;
  sessionKey: string;
  embeddingProvider?: EmbeddingProvider | null;
  recentN?: number; // how many messages from tail to consider
};

export async function consolidateToEpisode(
  params: ConsolidateParams,
): Promise<Omit<EpisodeEvent, "id" | "timestamp"> | null> {
  const recentN = params.recentN ?? 30;
  const allLines = await parseSessionMessages(params.sessionFile);
  if (allLines.length === 0) {
    return null;
  }
  // Take the last N messages
  const lines = allLines.slice(-recentN);
  const fields = extractEpisodeFields(lines);
  if (!fields) {
    return null;
  }

  let embedding: string | null = null;
  if (params.embeddingProvider) {
    try {
      const vec = await params.embeddingProvider.embedQuery(
        `${fields.user_intent} ${fields.action_taken} ${fields.outcome}`,
      );
      embedding = JSON.stringify(vec);
    } catch {
      // Embedding failure is non-fatal
    }
  }

  const raw_json = JSON.stringify({
    session_key: params.sessionKey,
    user_intent: fields.user_intent,
    action_taken: fields.action_taken,
    outcome: fields.outcome,
    id: randomUUID(),
  });

  return {
    session_key: params.sessionKey,
    user_intent: fields.user_intent,
    action_taken: fields.action_taken,
    outcome: fields.outcome,
    raw_json,
    embedding,
    importance: 1.0,
  };
}
