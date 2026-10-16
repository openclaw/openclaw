// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import * as canvas from "../../../../src/chat/canvas-render.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";

afterEach(() => vi.restoreAllMocks());

function result(id: string) {
  return { type: "tool_result", id, name: "custom", text: JSON.stringify({ exitCode: 0, id }) };
}

function item(message: Record<string, unknown>, key = "current"): ChatItem {
  return { kind: "message", key, message };
}

describe("tool activity preparation cache", () => {
  it("coalesces a new projected boundary's invocation without borrowing from the previous turn", () => {
    const previous = {
      role: "assistant",
      content: [{ type: "tool_call", id: "call", name: "custom", arguments: { turn: "old" } }],
    };
    const current = {
      role: "assistant",
      content: [{ type: "tool_call", id: "call", name: "custom", arguments: { turn: "new" } }],
      __openclaw: { turnBoundary: true },
    };
    const rows = coalesceToolActivityMessages([
      item(previous, "previous"),
      item(current, "current"),
      item({ role: "toolResult", content: [result("call")] }, "result"),
    ]).filter((row) => row.kind === "message");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.message).toBe(previous);
    expect(extractToolCardsCached(rows[1]?.message)[0]).toMatchObject({
      callId: "call",
      completed: true,
    });
  });

  it("reuses finalized bundles across prepends and invalidates only changed sources", () => {
    const invocation = (id: string) => {
      const call = {
        role: "assistant",
        content: [
          { type: "text", text: `before ${id}` },
          { type: "tool_call", id, name: "custom", arguments: {} },
          { type: "text", text: `after ${id}` },
        ],
      };
      const output = { role: "toolResult", content: [result(id)] };
      return {
        call,
        output,
        items: () => [item(call, `call-${id}`), item(output, `result-${id}`)],
      };
    };
    const first = invocation("first");
    const second = invocation("second");
    const older = invocation("older");
    const messages = (items: ChatItem[]) =>
      coalesceToolActivityMessages(items).flatMap((row) =>
        row.kind === "message" ? [row.message] : [],
      );
    const initial = messages([...first.items(), ...second.items()]);
    const prepare = vi.spyOn(canvas, "extractCanvasFromText");
    initial.forEach((message) => {
      extractToolCardsCached(message);
      const record = message as { content: unknown[] };
      Object.freeze(record.content);
      Object.freeze(message);
    });
    const calls = prepare.mock.calls.length;
    const rebuilt = messages([...first.items(), ...second.items()]);
    expect(rebuilt[0]).toBe(initial[0]);
    expect(rebuilt[1]).toBe(initial[1]);
    const prepended = messages([...older.items(), ...first.items(), ...second.items()]);
    expect(prepended[1]).toBe(initial[0]);
    expect(prepended[2]).toBe(initial[1]);
    rebuilt.forEach(extractToolCardsCached);
    expect(prepare).toHaveBeenCalledTimes(calls + 1); // Only the newly prepended output.

    first.output.content = [{ ...first.output.content[0]!, text: '{"exitCode":1}' }];
    const replacedBlock = messages([...first.items(), ...second.items()]);
    expect(replacedBlock[0]).not.toBe(initial[0]);
    expect(replacedBlock[1]).toBe(initial[1]);
    const replacedMessage = messages([
      item({ ...first.call }, "call-first"),
      first.items()[1]!,
      ...second.items(),
    ]);
    expect(replacedMessage[0]).not.toBe(replacedBlock[0]);
    expect(replacedMessage[1]).toBe(initial[1]);
    expect(extractToolCardsCached(initial[0])[0]?.exitCode).toBe(0);
    expect(extractToolCardsCached(replacedBlock[0])[0]?.exitCode).toBe(1);
  });

  it.each(["anonymous sibling", "standalone"])(
    "prepares %s output once across rebuilds and older pages",
    (shape) => {
      const block = result("current");
      const message =
        shape === "standalone"
          ? { role: "toolResult", toolCallId: block.id, toolName: block.name, content: block.text }
          : {
              role: "assistant",
              content: [
                ...(shape === "anonymous sibling"
                  ? [{ type: "tool_call", name: "other", arguments: {} }]
                  : []),
                block,
              ],
            };
      const prepare = vi.spyOn(canvas, "extractCanvasFromText");
      const current = item(message);
      const first = coalesceToolActivityMessages([current]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(1);
      expect(coalesceToolActivityMessages([current])).toEqual(first);
      const olderBlock = result("older");
      const older = item({ role: "assistant", content: [olderBlock] }, "older");
      expect(coalesceToolActivityMessages([older, current])).toEqual([older, ...first]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(1);
      expect(prepare.mock.calls.filter(([text]) => text === olderBlock.text)).toHaveLength(1);

      coalesceToolActivityMessages([item({ ...message })]);
      expect(prepare.mock.calls.filter(([text]) => text === block.text)).toHaveLength(2);
    },
  );
});

describe("tool activity outcome authority", () => {
  const activity = (status?: AgentActivityItem["status"]): AgentActivityItem => ({
    itemId: "tool:active",
    toolCallId: "active",
    name: "exec",
    kind: "tool",
    title: "Run checks",
    phase: status === "running" ? "start" : "end",
    ...(status ? { status } : { summary: "Outcome unknown" }),
  });
  const call = (status?: AgentActivityItem["status"], live = false) =>
    item(
      {
        role: "assistant",
        runId: "run",
        content: [
          { type: "toolCall", id: "active", name: "exec", arguments: { command: "pnpm check" } },
        ],
        activity: [{ ...activity(status), ...(!live && !status ? { unpairedCall: true } : {}) }],
        ...(live
          ? { __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false }
          : {}),
      },
      live ? "live" : "history",
    );
  const outcomes = (rows: ChatItem[]) =>
    coalesceToolActivityMessages(rows).flatMap((row) =>
      row.kind === "message" ? readPreparedActivity(row.message) : [],
    );

  it.each([false, true])(
    "lets live activity replace a history placeholder (live first: %s)",
    (liveFirst) => {
      const history = call();
      const live = call("running", true);
      expect(outcomes(liveFirst ? [live, history] : [history, live])).toEqual([
        activity("running"),
      ]);
      expect(outcomes([history])).toEqual([{ ...activity(), unpairedCall: true }]);
    },
  );

  it.each([undefined] as const)(
    "retains a durable %s result over stale live activity",
    (status) => {
      const terminal = item(
        {
          role: "toolResult",
          runId: "run",
          toolCallId: "active",
          toolName: "exec",
          content: [{ type: "text", text: "Command ended" }],
          activity: [activity(status)],
        },
        "result",
      );
      for (const rows of [
        [call(), terminal, call("running", true)],
        [call("running", true), call(), terminal],
      ]) {
        expect(outcomes(rows)).toEqual([activity(status)]);
      }
    },
  );

  it.each([undefined] as const)(
    "retains a terminal %s outcome when its raw result is outside the page",
    (status) => {
      const history = item({
        role: "assistant",
        runId: "run",
        content: [{ type: "toolCall", id: "active", name: "exec", arguments: {} }],
        activity: [activity(status)],
      });
      expect(outcomes([history, call("running", true)])).toEqual([activity(status)]);
    },
  );
});
