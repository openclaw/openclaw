import { expect, it } from "vitest";
import { readChatHistoryRequestBudget } from "./chat-history-request-budget.ts";
import { prepareChatHistoryPages } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitChatHistoryPages } from "./chat-pane-history-packets.runtime.ts";
import {
  getChatSessionProjection,
  readChatSessionProjection,
  reduceChatSessionProjection,
  setChatRunOwner,
} from "./history-merge.ts";

const source = (seq: number, content = "native") => ({
  role: "assistant",
  content,
  __openclaw: { seq, id: `source-${seq}` },
});

it("reserves source fragments and repeated occurrences once across bridge and canonical pins", () => {
  const fragment = source(1);
  const sibling = source(1, "another projection");
  const native = [...Array.from({ length: 100 }, () => fragment), sibling];
  const host = makeChatHost();
  admitChatHistoryPages(host, [{ messages: native }], "around");
  const pending = { role: "user", content: "pending" };
  reduceChatSessionProjection(host, {
    type: "sendPending",
    runId: "pending",
    message: pending,
  });
  const live = { role: "assistant", content: "live" };
  reduceChatSessionProjection(host, {
    type: "runDelta",
    runId: "active",
    message: live,
  });
  reduceChatSessionProjection(host, {
    type: "messagePersisted",
    message: live,
    envelope: { runId: "active" },
  });
  const failed = { role: "assistant", content: "error" };
  reduceChatSessionProjection(host, {
    type: "runTerminal",
    runId: "failed",
    status: "error",
    message: failed,
  });
  reduceChatSessionProjection(host, {
    type: "messagePersisted",
    message: failed,
    envelope: { runId: "failed" },
  });
  const local = { role: "system", content: "local" };
  const projection = reduceChatSessionProjection(host, { type: "localOutput", message: local });
  expect(projection.messages).toHaveLength(105);
  const budget = readChatHistoryRequestBudget(host, {
    messages: projection.messages,
    requiredSources: new Set(["id:source-1"]),
  });
  expect(budget?.limit).toBe(295);
  expect(budget?.maxBytes).toBe(3 * 1024 * 1024 - JSON.stringify(projection.messages).length);
});

it("uses the publication owner's terminal pin, independently of the active run owner", () => {
  const host = makeChatHost();
  const native = source(1);
  admitChatHistoryPages(host, [{ messages: [native] }], "around");
  host.readTranscriptReaderSnapshot = () => ({
    anchor: "id:source-1",
    visibleSources: ["id:source-1"],
  });
  const terminal = { ...source(2), __openclaw: { id: "source-2", seq: 2, runId: "terminal" } };
  Object.assign(host, { lastLocalTerminalReconcile: { runId: "terminal" } });
  reduceChatSessionProjection(host, {
    type: "runTerminal",
    runId: "terminal",
    status: "completed",
    message: terminal,
  });
  reduceChatSessionProjection(host, { type: "messagePersisted", message: terminal });
  setChatRunOwner(host, "unrelated");
  expect(getChatSessionProjection(host).messages).toContain(terminal);
  const facts = prepareChatHistoryPages(host, [], "older");
  expect(readChatHistoryRequestBudget(host, facts)?.limit).toBe(398);
});

it("reserves newest local weight without spending its unavoidable pair exemption", () => {
  const host = makeChatHost();
  admitChatHistoryPages(host, [{ messages: [source(1)] }], "around");
  const projection = reduceChatSessionProjection(host, {
    type: "localOutput",
    message: { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) },
  });
  expect(
    readChatHistoryRequestBudget(host, {
      messages: projection.messages,
      requiredSources: new Set(["id:source-1"]),
    }),
  ).toBeUndefined();
});

it("does not estimate unknown coverage or acquire a projection while reading capacity", () => {
  const host = makeChatHost();
  const before = host.chatMessages;
  const facts = { messages: [source(1)], requiredSources: new Set(["id:source-1"]) };
  expect(readChatHistoryRequestBudget(host, facts)).toBeUndefined();
  expect(host.chatMessages).toBe(before);
  expect(readChatSessionProjection(host)).toBeUndefined();
  admitChatHistoryPages(host, [{ messages: facts.messages }], "around");
  const sessionId = host.currentSessionId;
  host.currentSessionId = "successor";
  expect(readChatHistoryRequestBudget(host, facts)).toBeUndefined();
  host.currentSessionId = sessionId;
  expect(
    readChatHistoryRequestBudget(host, { ...facts, requiredSources: new Set(["id:missing"]) }),
  ).toBeUndefined();
});
