import { expect, it, vi } from "vitest";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

type IdentityFields = "sessionKey" | "assistantAgentId" | "agentsList" | "hello";
type LookupState = Pick<ChatPageHost, IdentityFields | "sessionsResult" | "sessionsResultAgentId">;

type SessionRow = NonNullable<LookupState["sessionsResult"]>["sessions"][number];

function lookup(sessions: SessionRow[], overrides: Partial<LookupState> = {}): ChatPageHost {
  const state: LookupState = {
    sessionKey: "agent:main:current",
    assistantAgentId: "main",
    agentsList: null,
    hello: null,
    sessionsResult: {
      ts: 0,
      path: "",
      count: sessions.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    },
    sessionsResultAgentId: "main",
    ...overrides,
  };
  // SAFETY: the lookup reads only these identity and session-result fields.
  return state as ChatPageHost;
}

it("reuses rows for interleaved panes without rescanning a shared session result", () => {
  const readKey = vi.fn(() => "agent:main:unselected");
  const other: SessionRow = { key: "agent:main:other", kind: "direct" };
  const selected: SessionRow = { key: "agent:main:current", kind: "direct" };
  const state = lookup([
    {
      kind: "direct",
      get key() {
        return readKey();
      },
    },
    other,
    selected,
  ]);
  expect(selectedChatSessionRow(state)).toBe(selected);
  const otherPane = lookup([], {
    sessionKey: "agent:main:other",
    sessionsResult: state.sessionsResult,
  });
  expect(selectedChatSessionRow(otherPane)).toBe(other);
  const initialReads = readKey.mock.calls.length;
  for (let i = 0; i < 10; i++) {
    expect(selectedChatSessionRow(state)).toBe(selected);
    expect(selectedChatSessionRow(otherPane)).toBe(other);
  }
  expect(readKey).toHaveBeenCalledTimes(initialReads);

  state.sessionKey = "agent:main:other";
  expect(selectedChatSessionRow(state)?.key).toBe("agent:main:other");
  const replacement: SessionRow = { ...other, displayName: "Fresh row" };
  state.sessionsResult = { ...state.sessionsResult!, sessions: [replacement] };
  expect(selectedChatSessionRow(state)).toBe(replacement);
});

it("recomputes selected rows when routing defaults change in place", () => {
  const agentsList: NonNullable<LookupState["agentsList"]> = {
    defaultId: "main",
    mainKey: "home",
    scope: "per-sender",
    agents: [],
  };
  const home: SessionRow = { key: "agent:main:home", kind: "direct" };
  const work: SessionRow = { key: "agent:work:home", kind: "direct" };
  const global: SessionRow = { key: "global", agentId: "work", kind: "global" };
  const state = lookup([home, work, global], {
    sessionKey: "main",
    agentsList,
    assistantAgentId: "work",
    sessionsResultAgentId: "work",
  });
  expect(selectedChatSessionRow(state)).toBe(home);
  agentsList.defaultId = "work";
  expect(selectedChatSessionRow(state)).toBe(work);
  agentsList.mainKey = "next";
  expect(selectedChatSessionRow(state)).toBeUndefined();
  agentsList.scope = "global";
  expect(selectedChatSessionRow(state)).toBe(global);
  state.assistantAgentId = "main";
  state.sessionKey = "global";
  expect(selectedChatSessionRow(state)).toBeUndefined();
});
