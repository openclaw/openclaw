// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import * as canvas from "../../../../src/chat/canvas-render.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";
import * as toolIdentity from "./tool-stream-identity.ts";

afterEach(() => vi.restoreAllMocks());

function result(id: string) {
  return { type: "tool_result", id, name: "custom", text: JSON.stringify({ exitCode: 0, id }) };
}

function item(message: Record<string, unknown>, key = "current"): ChatItem {
  return { kind: "message", key, message };
}

describe("tool activity preparation cache", () => {
  it("coalesces only new and seam turns and isolates cached wrappers", () => {
    const invocation = (id: string) => [
      item(
        { role: "assistant", content: [{ type: "tool_call", id, name: "custom", arguments: {} }] },
        `call-${id}`,
      ),
      item({ role: "toolResult", content: [result(id)] }, `result-${id}`),
    ];
    const older = invocation("older");
    const seam = invocation("seam");
    const retained = invocation("retained");
    const boundary = item({ role: "user", content: "next" }, "boundary");
    const initial = [seam[1]!, boundary, ...retained];
    const prepare = vi.spyOn(toolIdentity, "extractToolMessageRefs");
    const first = coalesceToolActivityMessages(initial);
    expect(prepare).toHaveBeenCalledTimes(3);
    prepare.mockClear();
    const repeat = coalesceToolActivityMessages(initial.map((row) => Object.assign({}, row)));
    expect(prepare).not.toHaveBeenCalled();
    expect(repeat).toEqual(first);
    expect(repeat.at(-1)).not.toBe(first.at(-1));
    const returned = repeat.at(-1)!;
    if (returned.kind !== "message") {
      throw new Error("expected tool message");
    }
    returned.duplicateCount = 17;
    returned.key = "mutated returned wrapper";

    const olderBoundary = item({ role: "user", content: "seam" }, "older-boundary");
    const prepended = coalesceToolActivityMessages([
      ...older,
      olderBoundary,
      ...seam,
      boundary,
      ...retained,
    ]);
    expect(prepare.mock.calls.map(([message]) => message)).toEqual(
      [...older, ...seam].map((row) => (row.kind === "message" ? row.message : undefined)),
    );
    expect(prepended.at(-1)).toEqual(first.at(-1));
    expect(prepended.at(-1)).not.toBe(first.at(-1));
    prepare.mockClear();
    const replacement = {
      ...retained[1]!,
      message: { role: "toolResult", content: [result("retained")] },
    } as ChatItem;
    coalesceToolActivityMessages([
      ...older,
      olderBoundary,
      ...seam,
      boundary,
      retained[0]!,
      replacement,
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("retains interleaved transcripts and replaces only the changed owner's turn", () => {
    const transcript = (id: string) => [
      item(
        { role: "assistant", content: [{ type: "tool_call", id, name: "custom", arguments: {} }] },
        `call-${id}`,
      ),
      item({ role: "toolResult", content: [result(id)] }, `result-${id}`),
    ];
    const first = transcript("first-pane");
    const second = transcript("second-pane");
    const prepare = vi.spyOn(toolIdentity, "extractToolMessageRefs");
    const firstOutput = coalesceToolActivityMessages(first);
    const secondOutput = coalesceToolActivityMessages(second);
    expect(prepare).toHaveBeenCalledTimes(4);

    prepare.mockClear();
    expect(coalesceToolActivityMessages(first)).toEqual(firstOutput);
    expect(coalesceToolActivityMessages(second)).toEqual(secondOutput);
    coalesceToolActivityMessages([]);
    expect(coalesceToolActivityMessages(first)).toEqual(firstOutput);
    expect(prepare).not.toHaveBeenCalled();

    const changed = [
      first[0]!,
      item(
        { role: "toolResult", content: [{ ...result("first-pane"), text: "updated" }] },
        "result-first-pane",
      ),
    ];
    const changedOutput = coalesceToolActivityMessages(changed);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(changedOutput).not.toEqual(firstOutput);
    prepare.mockClear();
    expect(coalesceToolActivityMessages(second)).toEqual(secondOutput);
    expect(coalesceToolActivityMessages(changed)).toEqual(changedOutput);
    expect(prepare).not.toHaveBeenCalled();

    // The owner retains one current entry, not every historical input variant.
    expect(coalesceToolActivityMessages(first)).toEqual(firstOutput);
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockClear();
    expect(coalesceToolActivityMessages(second)).toEqual(secondOutput);
    expect(coalesceToolActivityMessages(first)).toEqual(firstOutput);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("invalidates ordered wrapper inputs and bypasses transient turns", () => {
    const message = {
      role: "assistant",
      content: [{ type: "tool_call", id: "call", name: "custom", arguments: {} }],
    };
    const source = item(message, "source");
    const prepare = vi.spyOn(toolIdentity, "extractToolMessageRefs");
    coalesceToolActivityMessages([source]);
    for (const changed of [
      { ...source, key: "new-key" },
      { ...source, duplicateCount: 2 },
      { ...source, startsTurn: true as const },
    ]) {
      prepare.mockClear();
      expect(coalesceToolActivityMessages([changed])).toEqual([changed]);
      expect(prepare).toHaveBeenCalledTimes(1);
    }
    const stream: ChatItem = {
      kind: "stream",
      key: "stream",
      text: "one",
      startedAt: 1,
      isStreaming: true,
    };
    const first = coalesceToolActivityMessages([source, stream]);
    stream.text = "two";
    stream.replyToSender = { name: "Alice" };
    prepare.mockClear();
    const next = coalesceToolActivityMessages([source, stream]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(next.at(-1)).toBe(stream);
    expect(first[0]).toEqual(next[0]);
  });

  it.each(["startsTurn", "projected"] as const)(
    "coalesces a new %s boundary's invocation without borrowing from the previous turn",
    (boundary) => {
      const previous = {
        role: "assistant",
        content: [{ type: "tool_call", id: "call", name: "custom", arguments: { turn: "old" } }],
      };
      const current = {
        role: "assistant",
        content: [{ type: "tool_call", id: "call", name: "custom", arguments: { turn: "new" } }],
        ...(boundary === "projected" ? { __openclaw: { turnBoundary: true } } : {}),
      };
      const rows = coalesceToolActivityMessages([
        item(previous, "previous"),
        { ...item(current, "current"), ...(boundary === "startsTurn" ? { startsTurn: true } : {}) },
        item({ role: "toolResult", content: [result("call")] }, "result"),
      ]).filter((row) => row.kind === "message");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.message).toBe(previous);
      expect(extractToolCardsCached(rows[1]?.message)[0]).toMatchObject({
        callId: "call",
        completed: true,
      });
    },
  );

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

  it.each(["identified", "anonymous sibling", "standalone"])(
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

  it("re-extracts a replaced block while retaining its unchanged siblings", () => {
    const block = result("changed");
    const sibling = result("sibling");
    const message = { role: "assistant", content: [block, sibling] };
    const prepare = vi.spyOn(canvas, "extractCanvasFromText");
    coalesceToolActivityMessages([item(message)]);
    message.content = [{ ...block, text: '{"exitCode":1}' }, sibling];
    coalesceToolActivityMessages([item(message)]);
    expect(prepare.mock.calls.map(([text]) => text)).toEqual([
      block.text,
      sibling.text,
      '{"exitCode":1}',
    ]);
  });
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

  it.each(["completed", "failed", "blocked", undefined] as const)(
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

  it.each(["completed", undefined] as const)(
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
