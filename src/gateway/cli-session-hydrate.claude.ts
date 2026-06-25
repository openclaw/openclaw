// PR7 hydration — the DOWN mirror of PR4's record-up. PR4 imports a local Claude transcript into the
// gateway's chat.history (up); this materializes the gateway-owned session BACK into a local Claude
// Code transcript so `claude --resume <sessionId>` continues the SAME conversation on any surface
// ("pick up anywhere"). The per-turn JSONL shape matches what Claude Code itself writes — verified
// live: claude --resume reads a transcript built by this and recalls the conversation.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A gateway-owned (chat.history) message — the canonical conversation the gateway stores. */
export type HydrationMessage = {
  role: string;
  content: unknown;
  timestamp?: number | string;
};

// Claude tolerates a version it didn't write, but stamping a recent one avoids migration prompts.
const HYDRATED_TRANSCRIPT_VERSION = "2.1.191";

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        const text = (block as { text?: unknown })?.text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toIsoTimestamp(timestamp: number | string | undefined, fallbackMs: number): string {
  if (typeof timestamp === "string" && timestamp) {
    return timestamp;
  }
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

/**
 * Build a Claude Code transcript (JSONL string) from gateway-owned messages. Only user/assistant
 * turns with text are emitted, linked through the `parentUuid` chain Claude expects; returns "" when
 * there is nothing to hydrate. Pure (caller supplies `nowMs`) so it stays deterministic + testable.
 */
export function buildClaudeCliTranscript(params: {
  messages: HydrationMessage[];
  sessionId: string;
  cwd: string;
  nowMs: number;
}): string {
  const common = {
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: params.cwd,
    sessionId: params.sessionId,
    version: HYDRATED_TRANSCRIPT_VERSION,
    gitBranch: "",
  };
  let parentUuid: string | null = null;
  const lines: string[] = [];
  let index = 0;
  for (const message of params.messages) {
    const text = extractText(message.content);
    if (!text) {
      continue;
    }
    const uuid = randomUUID();
    const timestamp = toIsoTimestamp(message.timestamp, params.nowMs + index);
    if (message.role === "user") {
      lines.push(
        JSON.stringify({
          parentUuid,
          promptId: randomUUID(),
          type: "user",
          message: { role: "user", content: text },
          uuid,
          timestamp,
          permissionMode: "bypassPermissions",
          promptSource: "sdk",
          ...common,
        }),
      );
    } else if (message.role === "assistant") {
      lines.push(
        JSON.stringify({
          parentUuid,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text }],
          },
          requestId: `req_hydrated_${uuid.slice(0, 12)}`,
          type: "assistant",
          uuid,
          timestamp,
          ...common,
        }),
      );
    } else {
      continue;
    }
    parentUuid = uuid;
    index += 1;
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Write the hydrated transcript to Claude's project dir for `cwd` so `claude --resume <sessionId>`
 * finds it. Returns the path, or undefined when there is nothing to hydrate. NOTE: the project-dir
 * encoding (`/` and `.` → `-`) is Claude's POSIX convention; Windows surfaces use a different scheme
 * (tracked alongside the PR3 Windows caveat).
 */
export function hydrateClaudeCliTranscript(params: {
  messages: HydrationMessage[];
  sessionId: string;
  cwd: string;
  nowMs: number;
  homeDir?: string;
}): string | undefined {
  const content = buildClaudeCliTranscript(params);
  if (!content) {
    return undefined;
  }
  const projectDir = params.cwd.replace(/[/.]/g, "-");
  const dir = join(params.homeDir ?? homedir(), ".claude", "projects", projectDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${params.sessionId}.jsonl`);
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}
