// @vitest-environment node
import { describe, expect, it } from "vitest";
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
function inlineRows(props: Parameters<typeof buildChatItems>[0]) {
  return buildChatItems(props)
    .flatMap<{ key: string; message: unknown }>((item) =>
      item.kind === "group" ? item.messages : item.kind === "message" ? [item] : [],
    )
    .filter(({ message }) =>
      normalizeMessage(message).content.some((item) => item.type === "plugin_view"),
    );
}

function inlineMessages(props: Parameters<typeof buildChatItems>[0]) {
  return inlineRows(props).map(({ message }) => normalizeMessage(message));
}

describe("inline plugin transcript rows", () => {
  it.each([false, true])(
    "searches derived history and live summaries with tool details visible=%s",
    (showToolCalls) => {
      const saved = ["one", "two"].map((id, index) =>
        Object.assign(result(id, index + 2), {
          __openclaw: { id: "saved-" + id, runId: "run" },
          content: [{ type: "text", text: "Tool metadata received." }],
        }),
      );
      const live = ["one", "two"].map((id, index) => ({
        role: "assistant",
        runId: "run",
        toolCallId: id,
        timestamp: index + 2,
        content: [
          { type: "toolresult", name: "show_incident", details: { pluginView: block(id) } },
        ],
      }));
      for (const source of ["history", "live", "settled"]) {
        const props = createProps({
          showToolCalls,
          messages: source === "live" ? [] : saved,
          toolMessages: source === "history" ? [] : live,
        });
        const unfiltered = inlineRows(props);
        expect(unfiltered).toHaveLength(2);
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
          expect(rows.map(({ key }) => key)).toEqual(
            indexes.map((index) => unfiltered[index]!.key),
          );
        }
      }
    },
  );

  it("shows two independent calls immediately with tool details hidden and deduplicates history settlement", () => {
    const live = (id: string, timestamp: number) => ({
      ...result(id, timestamp),
      role: "assistant",
      runId: "run",
      content: [
        { type: "toolcall", name: "show_incident", arguments: {} },
        { type: "toolresult", name: "show_incident", details: { pluginView: block(id) } },
      ],
    });
    const props = createProps({
      showToolCalls: false,
      runId: "run",
      messages: [{ role: "user", content: "Show incidents", timestamp: 1 }],
      toolMessages: [live("one", 3), live("two", 4)],
      streamSegments: [{ text: "Here are the incidents.", ts: 2, toolCallId: "one", runId: "run" }],
      stream: "",
      streamStartedAt: 2,
    });
    expect(inlineMessages(props).map((message) => message.content)).toEqual([
      [{ type: "text", text: "Showing one", name: undefined, args: undefined }, block("one")],
      [{ type: "text", text: "Showing two", name: undefined, args: undefined }, block("two")],
    ]);
    expect(
      inlineMessages({
        ...props,
        messages: [
          ...props.messages,
          { ...result("one", 3), __openclaw: { id: "saved-one", runId: "run" } },
        ],
      }),
    ).toHaveLength(2);
  });

  it("keeps tool-only/aborted history and page boundaries local instead of moving views into another turn", () => {
    for (const messages of [
      [result("one", 1)],
      [result("one", 1), { role: "user", content: "A different request", timestamp: 2 }],
    ]) {
      const rows = inlineMessages(createProps({ messages, showToolCalls: false }));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.timestamp).toBe(1);
    }
    expect(
      inlineMessages(
        createProps({
          messages: [{ role: "assistant", content: "Unrelated next page", timestamp: 3 }],
          showToolCalls: false,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps reused direct-call IDs distinct across runs and stable through history settlement", () => {
    const callId = "tool_call:direct:show_incident:1";
    const live = (runId: string) => ({
      ...result(callId, 10),
      role: "assistant",
      runId,
      content: [
        { type: "toolresult", name: "show_incident", details: { pluginView: block(callId) } },
      ],
    });
    const props = createProps({
      showToolCalls: false,
      toolMessages: [live("run-a"), live("run-a"), live("run-b")],
    });
    const liveRows = inlineRows(props);
    expect(liveRows).toHaveLength(2);
    expect(liveRows.map(({ message }) => message)).toMatchObject([
      { runId: "run-a" },
      { runId: "run-b" },
    ]);
    expect(new Set(liveRows.map(({ key }) => key)).size).toBe(2);
    const persisted = ["run-a", "run-b"].map((runId) =>
      Object.assign(result(callId, 10), {
        runId: "stale-envelope",
        __openclaw: { id: "saved-" + runId, runId },
      }),
    );
    const settled = inlineRows({ ...props, messages: [...persisted, persisted[0]] });
    expect(settled).toHaveLength(2);
    expect(settled.map(({ key }) => key)).toEqual(liveRows.map(({ key }) => key));
    expect(settled.map(({ message }) => normalizeMessage(message).id)).toEqual(
      liveRows.map(({ message }) => normalizeMessage(message).id),
    );
    expect(settled.map(({ message }) => message)).toMatchObject([
      { runId: "run-a" },
      { runId: "run-b" },
    ]);
  });

  it("preserves nested result owners rather than the enclosing message owner", () => {
    const callId = "tool_call:direct:show_incident:1";
    const content = [
      {
        type: "toolResult",
        toolCallId: callId,
        toolName: "show_incident",
        runId: "nested-a",
        details: { pluginView: block(callId) },
      },
      {
        type: "toolResult",
        toolCallId: callId,
        toolName: "show_incident",
        __openclaw: { runId: "nested-b" },
        details: { pluginView: block(callId) },
      },
    ];
    const rows = inlineRows(
      createProps({
        showToolCalls: false,
        messages: [
          {
            role: "custom",
            timestamp: 10,
            __openclaw: { id: "nested-row", runId: "enclosing-run" },
            content: [...content, content[0]],
          },
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ message }) => message)).toMatchObject([
      { runId: "nested-a" },
      { runId: "nested-b" },
    ]);
    expect(new Set(rows.map(({ key }) => key)).size).toBe(2);
    expect(new Set(rows.map(({ message }) => normalizeMessage(message).id)).size).toBe(2);
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
      const props = createProps({ showToolCalls: false, messages: sources });
      const rows = inlineRows(props);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(({ key }) => key)).size).toBe(2);
      expect(new Set(rows.map(({ message }) => normalizeMessage(message).id)).size).toBe(2);
      expect(
        inlineRows({
          ...props,
          messages: [
            { role: "user", content: "Unrelated older message", timestamp: 1 },
            ...sources,
          ],
        }).map(({ key }) => key),
      ).toEqual(rows.map(({ key }) => key));
      if (kind === "surface-id" || kind === "surface-message-id") {
        const settled = [1, 2].map((index) =>
          Object.assign(result(callId, 10), { __openclaw: { id: "row-" + index } }),
        );
        expect(inlineRows({ ...props, messages: settled }).map(({ key }) => key)).toEqual(
          rows.map(({ key }) => key),
        );
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
      inlineMessages(
        createProps({
          messages: [
            {
              role: "user",
              content: JSON.stringify(result("one", 1)),
              details: { pluginView: block("one") },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
