// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { buildItems } from "./chat-thread.test-support.ts";

const notice = {
  role: "assistant",
  content: [{ type: "text", text: "Trying a fallback model." }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  stopReason: "stop",
  timestamp: 2000,
  __openclaw: { id: "switch-1", runId: "run-1", seq: 2 },
  openclawDeliveryMirror: {
    kind: "model-fallback",
    runId: "run-1",
    fromModel: "primary/model-a",
    toModel: "secondary/model-b",
    reason: "empty_response",
  },
};

describe("model fallback transcript dividers", () => {
  it.each([false, true])("keeps one status surface with a separate answer=%s", (separateAnswer) => {
    const answer = { type: "text", text: "The work continued." };
    const media = { type: "image", url: "https://example.com/synthetic.png" };
    const status = {
      role: "assistant",
      text: "A transport-specific status notice.",
      content: [
        {
          type: "text",
          text: "A transport-specific status notice.",
          openclawStatusNotice: true,
          openclawFallback: true,
        },
        ...(!separateAnswer ? [answer, media] : []),
      ],
      timestamp: 2500,
      __openclaw: { id: "status-1", replyToId: "input-1" },
    };
    const messages = [
      notice,
      status,
      ...(separateAnswer ? [{ role: "assistant", content: [answer, media], timestamp: 3000 }] : []),
    ];
    const before = structuredClone(messages);
    const items = buildItems({ messages });
    expect(items.filter((item) => item.kind === "divider")).toHaveLength(1);
    const rendered = items.flatMap((item) =>
      item.kind === "group" ? item.messages.map(({ message }) => message) : [],
    );
    expect(rendered).toHaveLength(1);
    expect(normalizeMessage(rendered[0]).content).toMatchObject([answer, { type: "image" }]);
    expect(rendered[0]).toBe(separateAnswer ? messages[2] : status);
    expect(messages).toEqual(before);
  });

  it.each([false, true])(
    "renders a durable switch as a divider after history reload=%s",
    (reload) => {
      const source = reload ? structuredClone(notice) : notice;
      const history = [
        { role: "user", content: "Continue the work", timestamp: 1000 },
        source,
        { role: "assistant", content: "The work continued", timestamp: 3000 },
      ];
      const items = buildItems({ messages: history });
      expect(items.filter((item) => item.kind === "divider")).toEqual([
        expect.objectContaining({
          label: "Model fallback: primary/model-a → secondary/model-b",
          description: "Reason: empty response",
          timestamp: 2000,
        }),
      ]);
      expect(
        items.some(
          (item) =>
            item.kind === "group" && item.messages.some(({ message }) => message === history[1]),
        ),
      ).toBe(false);
      expect(items.filter((item) => item.kind === "group")).toHaveLength(2);
      expect(source).toEqual(notice);
    },
  );

  it.each([false, true])("renders a successful return after history reload=%s", (reload) => {
    const restored = {
      ...notice,
      timestamp: 4000,
      __openclaw: { id: "restore-1", runId: "run-2", seq: 4 },
      openclawDeliveryMirror: {
        kind: "model-fallback",
        phase: "restored",
        runId: "run-2",
        fromModel: "secondary/model-b",
        toModel: "primary/model-a",
      },
    };
    const history = [notice, restored];
    const items = buildItems({ messages: reload ? structuredClone(history) : history });
    expect(items.filter((item) => item.kind === "divider")).toEqual([
      expect.objectContaining({ label: "Model fallback: primary/model-a → secondary/model-b" }),
      expect.objectContaining({
        key: expect.stringContaining("restore-1"),
        label: "Returned to selected model: secondary/model-b → primary/model-a",
        timestamp: 4000,
      }),
    ]);
    expect(items.filter((item) => item.kind === "group")).toHaveLength(0);
  });

  it("does not interpret an unknown phase as a transition", () => {
    const items = buildItems({
      messages: [
        {
          ...notice,
          openclawDeliveryMirror: { ...notice.openclawDeliveryMirror, phase: "started" },
        },
      ],
    });
    expect(items.some((item) => item.kind === "divider")).toBe(false);
  });

  it("does not interpret a malformed marker as a switch", () => {
    const malformed = {
      ...notice,
      openclawDeliveryMirror: { ...notice.openclawDeliveryMirror, toModel: 42 },
    };
    const items = buildItems({ messages: [malformed] });
    expect(items.some((item) => item.kind === "divider")).toBe(false);
  });
});
