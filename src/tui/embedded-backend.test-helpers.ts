import { parseAgentSessionKey } from "../routing/session-key.js";

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
