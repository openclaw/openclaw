// @vitest-environment node
import { expect, it } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";

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
  const previous = assistant([toolCall("call", { turn: "old" })]);
  const current = assistant([toolCall("call", { turn: "new" })], {
    __openclaw: { turnBoundary: true },
  });
  const rows = messages([
    item(previous, "previous"),
    item(current, "current"),
    item({ role: "toolResult", content: [result("call")] }, "result"),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toBe(previous);
  expect(extractToolCardsCached(rows[1])[0]).toMatchObject({ callId: "call", completed: true });
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
