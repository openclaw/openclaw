import {
  getSessionEntry,
  resolveAgentIdFromSessionKey,
  type SessionEntry,
  upsertSessionEntry,
} from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

export function createTestFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: true,
      ...overrides,
    },
  } as unknown as FollowupRun;
}

export async function writeTestSessionRow(sessionKey: string, entry: SessionEntry): Promise<void> {
  upsertSessionEntry({
    agentId: resolveAgentIdFromSessionKey(sessionKey),
    sessionKey,
    entry,
  });
}

export function readTestSessionRow(sessionKey: string): SessionEntry | undefined {
  return getSessionEntry({
    agentId: resolveAgentIdFromSessionKey(sessionKey),
    sessionKey,
  });
}
