import { parseAgentSessionKey } from "../routing/session-key.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";

export async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

export function sendMainChat(backend: EmbeddedTuiBackend, message: string, runId: string) {
  return backend.sendChat({ sessionKey: "agent:main:main", message, runId });
}

type LoadSessionEntryMockResult = {
  agentId: string;
  cfg: Record<string, unknown>;
  canonicalKey: string;
  storePath?: string;
  store?: Record<string, unknown>;
  entry?: Record<string, unknown>;
};

export function localSessionEntry(
  sessionKey: string,
  opts?: { agentId?: string },
  overrides: Partial<LoadSessionEntryMockResult> = {},
): LoadSessionEntryMockResult {
  return {
    cfg: {},
    agentId: opts?.agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? "main",
    canonicalKey: sessionKey,
    storePath: "/tmp/openclaw-sessions.json",
    store: {},
    entry: {},
    ...overrides,
  };
}
