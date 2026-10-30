// @vitest-environment node
import { expect, it } from "vitest";
import type { PluginInlineViewBlock } from "../../../../src/shared/plugin-inline-view.js";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";

const block = (id: string): PluginInlineViewBlock => ({
  type: "plugin_view",
  pluginId: "incidents",
  viewId: "incident",
  toolCallId: id,
  toolName: "show_incident",
  summary: "Showing " + id,
  version: 1,
  payload: { incidentId: id },
});
const result = (id: string, timestamp: number) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "show_incident",
  timestamp,
  content: [{ type: "text", text: "Showing " + id }],
  details: { pluginView: block(id) },
});
type Props = Parameters<typeof createProps>[0];
const liveResult = (id: string, timestamp: number, runId = "run") => ({
  role: "assistant",
  toolCallId: id,
  timestamp,
  runId,
  content: [{ type: "toolresult", name: "show_incident", details: { pluginView: block(id) } }],
});
const savedResult = (id: string, timestamp: number, runId = "run") => ({
  ...result(id, timestamp),
  __openclaw: { id: "saved-" + id, runId },
});
function inlineRows(props: Props) {
  return buildChatItems(createProps({ showToolCalls: false, ...props }))
    .flatMap<{ key: string; message: unknown }>((item) =>
      item.kind === "group" ? item.messages : item.kind === "message" ? [item] : [],
    )
    .filter(({ message }) =>
      normalizeMessage(message).content.some((item) => item.type === "plugin_view"),
    );
}

function inlineMessages(props: Props) {
  return inlineRows(props).map(({ message }) => normalizeMessage(message));
}
const keys = (rows: ReturnType<typeof inlineRows>) => rows.map(({ key }) => key);
const ids = (rows: ReturnType<typeof inlineRows>) =>
  rows.map(({ message }) => normalizeMessage(message).id);
function expectDistinct(rows: ReturnType<typeof inlineRows>) {
  expect(rows).toHaveLength(2);
  expect(new Set(keys(rows)).size).toBe(2);
  expect(new Set(ids(rows)).size).toBe(2);
}

it.each([false, true])(
  "searches derived history and live summaries with tool details visible=%s",
  (showToolCalls) => {
    const saved = ["one", "two"].map((id, index) =>
      Object.assign(savedResult(id, index + 2), {
        content: [{ type: "text", text: "Tool metadata received." }],
      }),
    );
    const live = ["one", "two"].map((id, index) => liveResult(id, index + 2));
    for (const source of ["history", "live", "settled"]) {
      const props = createProps({
        showToolCalls,
        messages: source === "live" ? [] : saved,
        toolMessages: source === "history" ? [] : live,
      });
      const unfiltered = inlineRows(props);
      expect(unfiltered).toHaveLength(2);
      expect(unfiltered.map(({ message }) => normalizeMessage(message).content[1])).toEqual([
        block("one"),
        block("two"),
      ]);
      for (const [searchOpen, searchQuery, indexes] of [
        [true, " SHOWING ONE ", [0]],
        [true, "showing", [0, 1]],
        [true, "unrelated", []],
        [true, "Tool metadata received", []],
        [true, "   ", [0, 1]],
        [false, "unrelated", [0, 1]],
      ] as const) {
        const rows = inlineRows({ ...props, searchOpen, searchQuery });
        expect(
          rows.map(({ message }) => extractTextCached(message)),
          source + ": " + searchQuery,
        ).toEqual(indexes.map((index) => ["Showing one", "Showing two"][index]));
        expect(keys(rows)).toEqual(indexes.map((index) => unfiltered[index]!.key));
      }
    }
  },
);

it("keeps tool-only history and page boundaries local", () => {
  for (const messages of [
    [result("one", 1)],
    [result("one", 1), { role: "user", content: "A different request", timestamp: 2 }],
  ]) {
    const rows = inlineMessages({ messages });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.timestamp).toBe(1);
  }
});

it("keeps reused call IDs distinct across runs and stable on settlement", () => {
  const callId = "tool_call:direct:show_incident:1";
  const props = {
    toolMessages: ["run-a", "run-a", "run-b"].map((run) =>
      Object.assign(result(callId, 10), liveResult(callId, 10, run)),
    ),
  };
  const liveRows = inlineRows(props);
  expectDistinct(liveRows);
  expect(liveRows.map(({ message }) => message)).toMatchObject([
    { runId: "run-a" },
    { runId: "run-b" },
  ]);
  const persisted = ["run-a", "run-b"].map((runId) =>
    Object.assign(result(callId, 10), {
      runId: "stale-envelope",
      __openclaw: { id: "saved-" + runId, runId },
    }),
  );
  const settled = inlineRows({ ...props, messages: [...persisted, persisted[0]] });
  expect(settled).toHaveLength(2);
  expect(keys(settled)).toEqual(keys(liveRows));
  expect(ids(settled)).toEqual(ids(liveRows));
  expect(settled.map(({ message }) => message)).toMatchObject([
    { runId: "run-a" },
    { runId: "run-b" },
  ]);
});

it("preserves nested result owners instead of the enclosing owner", () => {
  const callId = "tool_call:direct:show_incident:1";
  const nested = {
    type: "toolResult",
    toolCallId: callId,
    toolName: "show_incident",
    details: { pluginView: block(callId) },
  };
  const content = [
    { ...nested, runId: "nested-a" },
    { ...nested, __openclaw: { runId: "nested-b" } },
  ];
  const rows = inlineRows({
    messages: [
      {
        role: "custom",
        timestamp: 10,
        __openclaw: { id: "nested-row", runId: "enclosing-run" },
        content: [...content, content[0]],
      },
    ],
  });
  expectDistinct(rows);
  expect(rows.map(({ message }) => message)).toMatchObject([
    { runId: "nested-a" },
    { runId: "nested-b" },
  ]);
});

it.each(["id", "surface-id", "surface-message-id", "sequence", "anonymous", "call-id-alias"])(
  "uses stable source identity when run ownership is absent: %s",
  (kind) => {
    const callId = "reused-call";
    const sources = [1, 2].map((index) =>
      Object.assign(
        result(callId, 10),
        kind === "id"
          ? { __openclaw: { id: "row-" + index } }
          : kind === "surface-id"
            ? { id: "row-" + index }
            : kind === "surface-message-id"
              ? { messageId: "row-" + index }
              : kind === "sequence"
                ? { __openclaw: { seq: index } }
                : kind === "call-id-alias"
                  ? { id: callId }
                  : {},
      ),
    );
    const props = { messages: sources };
    const rows = inlineRows(props);
    expectDistinct(rows);
    expect(
      inlineRows({
        ...props,
        messages: [{ role: "user", content: "Unrelated older message", timestamp: 1 }, ...sources],
      }).map(({ key }) => key),
    ).toEqual(keys(rows));
    if (kind === "surface-id" || kind === "surface-message-id") {
      const settled = [1, 2].map((index) =>
        Object.assign(result(callId, 10), { __openclaw: { id: "row-" + index } }),
      );
      expect(keys(inlineRows({ ...props, messages: settled }))).toEqual(keys(rows));
    }
    if (kind !== "anonymous" && kind !== "call-id-alias") {
      expect(inlineRows({ ...props, messages: [...sources, sources[0]] })).toHaveLength(2);
    }
  },
);

it("preserves explicitly projected fields and rejects user-authored inline blocks", () => {
  expect(normalizeMessage({ role: "assistant", content: [block("one")] }).content).toEqual([
    block("one"),
  ]);
  expect(normalizeMessage({ role: "user", content: [block("one")] }).content).toEqual([]);
  expect(
    inlineMessages({
      showToolCalls: true,
      messages: [
        {
          role: "user",
          content: JSON.stringify(result("one", 1)),
          details: { pluginView: block("one") },
        },
      ],
    }),
  ).toEqual([]);
});
