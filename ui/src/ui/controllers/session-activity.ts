import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionActivityResult, SessionActivityTool } from "../types.ts";

export type SessionActivityState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  sessionActivityLoading: boolean;
  sessionActivity: SessionActivityResult | null;
};

export async function loadSessionActivity(state: SessionActivityState) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  state.sessionActivityLoading = true;
  try {
    const result = await state.client.request<SessionActivityResult>("sessions.activity", {
      key: sessionKey,
      includeDescendants: true,
    });
    if (state.sessionKey === sessionKey) {
      state.sessionActivity = result;
    }
  } finally {
    if (state.sessionKey === sessionKey) {
      state.sessionActivityLoading = false;
    }
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function applySessionToolActivityEvent(
  state: SessionActivityState,
  payload: { runId?: unknown; sessionKey?: unknown; ts?: unknown; data?: unknown } | undefined,
) {
  const sessionKey = readNonEmptyString(payload?.sessionKey);
  const runId = readNonEmptyString(payload?.runId);
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const toolCallId = readNonEmptyString((data as Record<string, unknown>).toolCallId);
  const phase = readNonEmptyString((data as Record<string, unknown>).phase);
  if (!sessionKey || sessionKey !== state.sessionKey || !runId || !toolCallId) {
    return;
  }
  const id = `${runId}:${toolCallId}`;
  const existing = state.sessionActivity;
  const tools = existing?.tools ?? [];
  const base = {
    key: sessionKey,
    revision: existing?.revision ?? 0,
    includedSessionKeys: existing?.includedSessionKeys ?? [sessionKey],
    truncated: existing?.truncated ?? false,
    tasks: existing?.tasks ?? [],
  };
  if (phase === "result") {
    state.sessionActivity = {
      ...base,
      tools: tools.filter((tool) => tool.id !== id),
    };
    return;
  }
  const name = readNonEmptyString((data as Record<string, unknown>).name) ?? "tool";
  const now = typeof payload?.ts === "number" ? payload.ts : Date.now();
  const previous = tools.find((tool) => tool.id === id);
  const next: SessionActivityTool = {
    id,
    sessionKey,
    runId,
    toolCallId,
    name,
    title: name,
    status: "running",
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
  state.sessionActivity = {
    ...base,
    tools: [next, ...tools.filter((tool) => tool.id !== id)],
  };
}
