import { expect, it, vi } from "vitest";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

type LookupState = Pick<
  ChatPageHost,
  | "sessionKey"
  | "assistantAgentId"
  | "agentsList"
  | "hello"
  | "sessionsResult"
  | "sessionsResultAgentId"
>;

function createLookupState(overrides: Partial<LookupState> = {}): ChatPageHost {
  const state: LookupState = {
    sessionKey: "agent:main:current",
    assistantAgentId: "main",
    agentsList: null,
    hello: null,
    sessionsResult: null,
    sessionsResultAgentId: "main",
    ...overrides,
  };
  // SAFETY: the lookup reads only these identity and session-result fields.
  return state as ChatPageHost;
}

it("reuses the selected row without rescanning an unchanged session result", () => {
  const readKey = vi.fn(() => "agent:main:other");
  const selected = { key: "agent:main:current" };
  const state = createLookupState({
    sessionsResult: {
      ts: 0,
      count: 2,
      defaults: {},
      sessions: [
        {
          get key() {
            return readKey();
          },
        },
        selected,
      ],
    },
  });
  expect(selectedChatSessionRow(state)).toBe(selected);
  const initialReads = readKey.mock.calls.length;
  for (let i = 0; i < 10; i++) {
    expect(selectedChatSessionRow(state)).toBe(selected);
  }
  expect(readKey).toHaveBeenCalledTimes(initialReads);

  state.sessionKey = "agent:main:other";
  expect(selectedChatSessionRow(state)?.key).toBe("agent:main:other");
  const replacement = { key: "agent:main:other", displayName: "Fresh row" };
  state.sessionsResult = { ...state.sessionsResult!, sessions: [replacement] };
  expect(selectedChatSessionRow(state)).toBe(replacement);
});

it("recomputes selected rows when routing defaults change in place", () => {
  const agentsList = { defaultId: "main", mainKey: "home", scope: "per-sender" };
  const home = { key: "agent:main:home" };
  const work = { key: "agent:work:home" };
  const global = { key: "global", agentId: "work" };
  const state = createLookupState({
    sessionKey: "main",
    agentsList,
    assistantAgentId: "work",
    sessionsResultAgentId: "work",
    sessionsResult: { ts: 0, count: 3, defaults: {}, sessions: [home, work, global] },
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
