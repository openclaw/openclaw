// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import * as toolStreamIdentity from "./tool-stream-identity.ts";

type Fields = Record<string, unknown>;
function result(id: string) {
  return { type: "tool_result", id, name: "custom", text: JSON.stringify({ exitCode: 0, id }) };
}
const item = (message: Fields, key = "current"): ChatItem => ({ kind: "message", key, message });
function toolCall(id: string, args: Record<string, unknown> = {}) {
  return { type: "tool_call", id, name: "custom", arguments: args };
}
function assistant(content: unknown[], fields: Fields = {}) {
  return { role: "assistant", content, ...fields };
}
function invocation(id: string) {
  const call = assistant([toolCall(id)]);
  const output = { role: "toolResult", content: [result(id)] };
  return { call, output, items: () => [item(call, `call-${id}`), item(output, `result-${id}`)] };
}
const messages = (items: ChatItem[]) =>
  coalesceToolActivityMessages(items).flatMap((row) =>
    row.kind === "message" ? [row.message] : [],
  );
const sameReferences = (actual: unknown[], expected: unknown[]) =>
  actual.map((entry, index) => entry === expected[index]);

it("coalesces a new projected boundary's invocation without borrowing from the previous turn", () => {
  const readRefs = vi.spyOn(toolStreamIdentity, "extractToolMessageRefs");
  onTestFinished(() => readRefs.mockRestore());
  const previous = assistant([toolCall("call", { turn: "old" })], { runId: "run" });
  const current = assistant([toolCall("call", { turn: "new" })], {
    runId: "run",
    __openclaw: { turnBoundary: true },
  });
  const output = { role: "toolResult", runId: "run", content: [result("call")] };
  const rows = messages([
    item(previous, "previous"),
    item(current, "current"),
    item(output, "result"),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toBe(previous);
  expect(extractToolCardsCached(rows[1])[0]).toMatchObject({
    runId: "run",
    callId: "call",
    completed: true,
  });
  expect(readRefs).not.toHaveBeenCalled();
  const unscoped = { role: "toolResult", content: output.content };
  const repeated = assistant([toolCall("call", { turn: "repeat" })], {
    runId: "run",
    __openclawToolStreamLive: true,
  });
  const inferred = messages([
    item(previous, "previous"),
    item(current, "current"),
    item(repeated, "repeat"),
    item(unscoped, "result"),
  ]);
  expect(inferred[0]).toBe(previous);
  expect(extractToolCardsCached(inferred[1])[0]).toMatchObject({
    runId: "run",
    callId: "call",
    completed: true,
  });
  expect(readRefs).toHaveBeenCalledTimes(3);
  const peer = assistant([toolCall("call", { turn: "peer" })], {
    runId: "other",
    __openclawToolStreamLive: true,
  });
  const ambiguous = messages([
    item(previous, "previous"),
    item(current, "current"),
    item(peer, "peer"),
    item(repeated, "repeat"),
    item(unscoped, "result"),
  ]);
  expect(ambiguous[0]).toBe(previous);
  const cards = ambiguous.slice(1).flatMap(extractToolCardsCached);
  expect(cards.map((card) => card.runId)).toEqual(["run", "other", undefined]);
  expect(cards[2]).toMatchObject({ callId: "call", completed: true });
  expect(readRefs).toHaveBeenCalledTimes(7);
});

it("invalidates replaced blocks and messages without rebuilding unrelated bundles", () => {
  const first = invocation("first");
  const second = invocation("second");
  const initial = messages([...first.items(), ...second.items()]);
  first.output.content = [{ ...first.output.content[0]!, text: '{"exitCode":1}' }];
  const replacedBlock = messages([...first.items(), ...second.items()]);
  expect(sameReferences(replacedBlock, initial)).toEqual([false, true]);
  const replacedMessage = messages([
    item({ ...first.call }, "call-first"),
    first.items()[1]!,
    ...second.items(),
  ]);
  expect(sameReferences(replacedMessage, replacedBlock)).toEqual([false, true]);
  expect(extractToolCardsCached(initial[0])[0]?.exitCode).toBe(0);
  expect(extractToolCardsCached(replacedBlock[0])[0]?.exitCode).toBe(1);
});
const activity = (status?: AgentActivityItem["status"]): AgentActivityItem => ({
  itemId: "tool:active",
  toolCallId: "active",
  name: "exec",
  kind: "tool",
  title: "Run checks",
  phase: status === "running" ? "start" : "end",
  ...(status ? { status } : { summary: "Outcome unknown" }),
});
const execution = (content: unknown[], fields: Fields = {}, key = "current") =>
  item({ role: "assistant", runId: "run", activity: [activity()], content, ...fields }, key);
const activeCall = { type: "toolCall", id: "active", name: "exec", arguments: {} };
const call = (status?: AgentActivityItem["status"], live = false) =>
  execution(
    [{ ...activeCall, arguments: { command: "pnpm check" } }],
    {
      activity: [{ ...activity(status), ...(!live && !status ? { unpairedCall: true } : {}) }],
      ...(live
        ? { __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false }
        : {}),
    },
    live ? "live" : "history",
  );
const outcomes = (rows: ChatItem[]) => messages(rows).flatMap(readPreparedActivity);

it.each([false, true])("replaces history placeholders (live first: %s)", (liveFirst) => {
  const history = call();
  const live = call("running", true);
  expect(outcomes(liveFirst ? [live, history] : [history, live])).toEqual([activity("running")]);
  expect(outcomes([history])).toEqual([{ ...activity(), unpairedCall: true }]);
});
it.each([true, false])("retains durable outcomes over stale live (raw=%s)", (hasRawResult) => {
  const terminal = execution(
    hasRawResult ? [{ type: "text", text: "Command ended" }] : [activeCall],
    {
      role: hasRawResult ? "toolResult" : "assistant",
      ...(hasRawResult ? { toolCallId: "active", toolName: "exec" } : {}),
    },
    hasRawResult ? "result" : "current",
  );
  const live = call("running", true);
  const orders = hasRawResult
    ? [
        [call(), terminal, live],
        [live, call(), terminal],
      ]
    : [[terminal, live]];
  for (const rows of orders) {
    expect(outcomes(rows)).toEqual([activity()]);
  }
});

it.each(["text", "thinking"])("keeps %s apart from its calls and prepared activity", (type) => {
  const prose = (value: string) => ({ type, text: value, thinking: value });
  const content = [prose("Now."), activeCall, prose("Then."), toolCall("b")];
  const rows = messages([execution(content)]);
  const cards = rows.map(extractToolCardsCached);
  expect(cards.map((list) => list.map((card) => card.callId))).toEqual([[], ["active"], [], ["b"]]);
  expect(rows.flatMap(readPreparedActivity)).toEqual([activity()]);
});

it("reuses sibling prose during interleaved live-tool updates and invalidates replaced content", () => {
  const firstText = { type: "text", text: "Before the first tool" };
  const image = { type: "image", source: { type: "url", url: "https://example.com/map.png" } };
  const middleText = { type: "text", text: "Between tools" };
  const lastText = { type: "text", text: "After both tools" };
  const source = assistant(
    [firstText, toolCall("first"), image, middleText, toolCall("second"), lastText],
    { runId: "run-a", senderLabel: "Original sender" },
  );
  const live = (text: string, runId = "run-a") =>
    item(
      {
        role: "toolResult",
        runId,
        __openclawToolStreamLive: true,
        toolCallId: "first",
        toolName: "custom",
        content: [{ ...result("first"), text }],
      },
      "live-first",
    );
  const project = (output: string) => messages([item(source, "shared-key"), live(output)]);
  const initial = project("first output");
  expect(initial).toHaveLength(5);
  expect(initial).toEqual([
    expect.objectContaining({ content: [firstText] }),
    expect.anything(),
    expect.objectContaining({ content: [image, middleText] }),
    expect.anything(),
    expect.objectContaining({ content: [lastText] }),
  ]);

  // Another caller uses the same row and call keys, but a different source owner.
  const peer = assistant([...source.content], { runId: "run-b", senderLabel: "Peer sender" });
  const other = messages([item(peer, "shared-key"), live("peer output", "run-b")]);
  expect(other[0]).not.toBe(initial[0]);
  expect(other[0]).toMatchObject({ senderLabel: "Peer sender", content: [firstText] });

  const updated = project("new first output");
  expect(sameReferences(updated, initial)).toEqual([true, false, true, true, true]);
  expect(extractToolCardsCached(updated[1])[0]?.outputText).toBe("new first output");
  expect(updated[0]).toMatchObject({ senderLabel: "Original sender" });

  // The card owner accepts in-place content replacement on an existing raw message.
  source.content = [{ type: "text", text: "Replaced narration" }, ...source.content.slice(1)];
  const replaced = project("new first output");
  expect(replaced[0]).not.toBe(updated[0]);
  expect(replaced[0]).toMatchObject({ content: [{ type: "text", text: "Replaced narration" }] });
  expect(replaced[2]).toMatchObject({ content: [image, middleText] });
  expect(replaced[4]).toMatchObject({ content: [lastText] });
});
