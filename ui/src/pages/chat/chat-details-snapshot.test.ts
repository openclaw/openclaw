/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { captureChatDetailsSnapshot, projectDetailsSubagents } from "./chat-details-snapshot.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

function cachedPane() {
  const { state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ recoveryScope: "details-account" }),
  });
  state.currentSessionId = "details-session";
  const target = { sessionKey: state.sessionKey };
  cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, {
    messages: [],
    pagination: { hasMore: false },
    sessionId: state.currentSessionId,
  });
  return { state, read: () => readChatSessionSnapshot(state.chatMessagesBySession, state, target) };
}

it("adopts display facts from the current snapshot and merges independent section receipts", () => {
  const { state, read } = cachedPane();
  const receipt = captureChatDetailsSnapshot(state)!;
  expect(receipt.details).toBeUndefined();
  receipt.write({ subagents: { total: 0, rows: [], counts: [] }, outputs: 2 });
  receipt.write({ automations: { rows: [], total: 0, more: false } });
  expect(captureChatDetailsSnapshot(state)?.details).toEqual({
    locale: i18n.getLocale(),
    subagents: { total: 0, rows: [], counts: [] },
    automations: { rows: [], total: 0, more: false },
    outputs: 2,
  });
  expect(read()?.details?.outputs).toBe(2);
});

it.each<{ name: string; change: (state: ChatPageHost) => void }>([
  { name: "connection epoch", change: (state) => state.connectionEpoch++ },
  {
    name: "account scope on the same client",
    change: (state) => {
      Object.defineProperty(state.client!, "recoveryScope", { value: "other-account" });
      cacheChatSessionSnapshot(
        state.chatMessagesBySession,
        state,
        { sessionKey: state.sessionKey },
        {
          messages: [],
          pagination: { hasMore: false },
          sessionId: state.currentSessionId,
        },
      );
    },
  },
  {
    name: "connection client",
    change: (state) => {
      state.client = createGatewayBrowserClientFixture({ recoveryScope: "details-account" });
    },
  },
  {
    name: "disconnect",
    change: (state) => {
      state.connected = false;
    },
  },
  {
    name: "session incarnation",
    change: (state) => {
      state.currentSessionId = "replacement";
    },
  },
  {
    name: "selected session",
    change: (state) => {
      state.sessionKey = "agent:main:other";
    },
  },
])("rejects a late section receipt after $name changes", ({ change }) => {
  const { state, read } = cachedPane();
  const receipt = captureChatDetailsSnapshot(state)!;
  change(state);
  receipt.write({ outputs: 99 });
  expect(read()?.details).toBeUndefined();
});

it("does not adopt another account's display facts", () => {
  const { state } = cachedPane();
  captureChatDetailsSnapshot(state)!.write({ outputs: 2 });
  state.client = createGatewayBrowserClientFixture({ recoveryScope: "other-account" });
  expect(captureChatDetailsSnapshot(state)).toBeUndefined();
});

it("discards display labels from another locale instead of merging them into a new receipt", () => {
  const { state, read } = cachedPane();
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey: state.sessionKey },
    {
      ...read()!,
      details: { locale: "other-locale", subagents: { rows: [], counts: [], total: 0 } },
    },
  );
  const receipt = captureChatDetailsSnapshot(state)!;
  expect(receipt.details).toBeUndefined();
  receipt.write({ outputs: 0 });
  expect(read()?.details).toEqual({ locale: i18n.getLocale(), outputs: 0 });
});

it("bounds the cached Subagents presentation and excludes non-display fields", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    key: `agent:main:subagent:${index}`,
    label: `Worker ${index}`,
    status: index === 29 ? ("running" as const) : ("done" as const),
    session: { transcript: "not display data" },
  }));
  expect(projectDetailsSubagents(rows)).toEqual({
    total: 30,
    rows: [29, 0, 1, 2].map((index) => ({
      key: `agent:main:subagent:${index}`,
      label: `Worker ${index}`,
      status: index === 29 ? "running" : "done",
    })),
    counts: [
      { status: "running", count: 1 },
      { status: "done", count: 29 },
    ],
  });
});
