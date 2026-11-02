import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  prepareChatHistoryRequestBudget,
  readChatHistoryRequestBudget,
} from "./chat-history-request-budget.ts";
import { prepareChatHistoryPages, admitChatHistoryPages } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  getChatSessionProjection,
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
  let projection = createSessionProjection({ sessionKey: "budget" }, native);
  const pending = { role: "user", content: "pending" };
  projection = reduceSessionProjection(projection, {
    type: "sendPending",
    runId: "pending",
    message: pending,
  });
  const live = { role: "assistant", content: "live" };
  projection = reduceSessionProjection(projection, {
    type: "runDelta",
    runId: "active",
    message: live,
  });
  projection = reduceSessionProjection(projection, {
    type: "messagePersisted",
    message: live,
    envelope: { runId: "active" },
  });
  const failed = { role: "assistant", content: "error" };
  projection = reduceSessionProjection(projection, {
    type: "runTerminal",
    runId: "failed",
    status: "error",
    message: failed,
  });
  projection = reduceSessionProjection(projection, {
    type: "messagePersisted",
    message: failed,
    envelope: { runId: "failed" },
  });
  const local = { role: "system", content: "local" };
  projection = reduceSessionProjection(projection, { type: "localOutput", message: local });
  expect(projection.messages).toHaveLength(105);
  const budget = prepareChatHistoryRequestBudget(
    projection,
    projection.messages,
    new Set(["id:source-1"]),
  );
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
  let projection = createSessionProjection({ sessionKey: "budget" }, [source(1)]);
  projection = reduceSessionProjection(projection, {
    type: "localOutput",
    message: { role: "system", content: "x".repeat(3 * 1024 * 1024 - 100_000) },
  });
  expect(
    prepareChatHistoryRequestBudget(projection, projection.messages, new Set(["id:source-1"])),
  ).toBeUndefined();
});

it("does not estimate unknown coverage or acquire a projection while reading capacity", () => {
  const host = makeChatHost();
  const before = host.chatMessages;
  const facts = { messages: [source(1)], requiredSources: new Set(["id:source-1"]) };
  expect(readChatHistoryRequestBudget(host, facts)).toBeUndefined();
  expect(host.chatMessages).toBe(before);
  admitChatHistoryPages(host, [{ messages: facts.messages }], "around");
  host.currentSessionId = "successor";
  expect(readChatHistoryRequestBudget(host, facts)).toBeUndefined();
  const projection = createSessionProjection({ sessionKey: "budget" }, facts.messages);
  expect(
    prepareChatHistoryRequestBudget(projection, facts.messages, new Set(["id:missing"])),
  ).toBeUndefined();
});
