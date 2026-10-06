import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  activatedConversation,
  createHarness,
  message,
} from "../../packages/gateway-client/src/model/conversation.test-support.js";
import { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";

describe("Canvas history through the Control Model", () => {
  it.each<{
    name: string;
    views: { id?: string; url: string }[];
    messageId?: string;
  }>([
    { name: "URL-only previews", views: [{ url: "/one" }, { url: "/two" }] },
    {
      name: "long URL-only previews",
      views: [{ url: `/${"x".repeat(1_900)}one` }, { url: `/${"x".repeat(1_900)}two` }],
    },
    {
      name: "explicit view identities",
      views: [
        { id: "one", url: "/one" },
        { id: "two", url: "/two" },
      ],
    },
    {
      name: "maximum-length message identities",
      views: [{ url: "/one" }, { url: "/two" }],
      messageId: "m".repeat(512),
    },
  ])(
    "preserves $name across history reorder and reconnect",
    async ({ views, messageId = "message-2" }) => {
      const history = (orderedViews: typeof views) => {
        const target = {
          ...message(2),
          __openclaw: { id: messageId, seq: 2 },
          content: [{ type: "text", text: "Canvas results" }],
        };
        const messages = [
          ...orderedViews.map((view) => ({
            role: "toolResult",
            toolName: "canvas",
            content: JSON.stringify({ kind: "canvas", view }),
          })),
          target,
        ];
        const original = JSON.stringify(messages);
        const projected = augmentChatHistoryWithCanvasBlocks(messages);
        expect(JSON.stringify(messages)).toBe(original);
        expect(asOptionalRecord(projected.at(-1))?.content).toHaveLength(3);
        return { messages: projected, completeSnapshot: true };
      };
      const harness = createHarness({ status: "connected", epoch: 1 }, { history: history(views) });
      const { model, conversation } = await activatedConversation(harness);
      try {
        const identities = () => {
          const artifacts = conversation.getSnapshot().artifacts;
          expect(artifacts).toHaveLength(2);
          expect(artifacts.every((artifact) => artifact.state === "ready")).toBe(true);
          expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(2);
          expect(
            artifacts.every((artifact) => new TextEncoder().encode(artifact.id).length <= 256),
          ).toBe(true);
          expect(artifacts.every((artifact) => artifact.source.messageId === messageId)).toBe(true);
          return artifacts
            .map((artifact) => [artifact.views[0]?.fallback, artifact.id])
            .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        };
        const originalIdentities = identities();
        for (const epoch of [2, 3]) {
          harness.setConnection({ status: "disconnected", epoch: epoch - 1 });
          harness.setHistory(0, history(epoch === 2 ? views.toReversed() : views));
          harness.setConnection({ status: "connected", epoch });
          await vi.waitFor(() => expect(harness.callsFor("chat.history")).toHaveLength(epoch));
          await vi.waitFor(() => expect(conversation.getSnapshot().history.status).toBe("ready"));
          expect(identities()).toEqual(originalIdentities);
        }
        if (views[0]?.id) {
          expect(
            conversation
              .getSnapshot()
              .artifacts.map((artifact) => artifact.id)
              .toSorted((left, right) => left.localeCompare(right)),
          ).toEqual(["canvas:one", "canvas:two"]);
        }
      } finally {
        model.dispose();
      }
    },
  );

  it("keeps equal URLs in different messages distinct", async () => {
    const history = {
      messages: augmentChatHistoryWithCanvasBlocks(
        [2, 4].flatMap((sequence) => [
          {
            role: "toolResult",
            toolName: "canvas",
            content: JSON.stringify({ kind: "canvas", view: { url: "/one" } }),
          },
          { ...message(sequence), content: [{ type: "text", text: "Canvas result" }] },
        ]),
      ),
      completeSnapshot: true,
    };
    const harness = createHarness({ status: "connected", epoch: 1 }, { history });
    const { model, conversation } = await activatedConversation(harness);
    try {
      const artifacts = conversation.getSnapshot().artifacts;
      expect(artifacts).toHaveLength(2);
      expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(2);
      expect(
        artifacts
          .map((artifact) => artifact.source.messageId)
          .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(["message-2", "message-4"]);
      expect(artifacts.every((artifact) => artifact.state === "ready")).toBe(true);
    } finally {
      model.dispose();
    }
  });

  it("retains one ready artifact for duplicate URL-only previews", async () => {
    const tool = {
      role: "toolResult",
      toolName: "canvas",
      content: JSON.stringify({ kind: "canvas", view: { url: "/one" } }),
    };
    const projected = augmentChatHistoryWithCanvasBlocks([
      tool,
      { ...tool },
      { ...message(2), content: [{ type: "text", text: "Canvas result" }] },
    ]);
    expect(asOptionalRecord(projected.at(-1))?.content).toHaveLength(2);
    const harness = createHarness(
      { status: "connected", epoch: 1 },
      { history: { messages: projected, completeSnapshot: true } },
    );
    const { model, conversation } = await activatedConversation(harness);
    try {
      expect(conversation.getSnapshot().artifacts).toHaveLength(1);
      expect(conversation.getSnapshot().artifacts[0]?.state).toBe("ready");
    } finally {
      model.dispose();
    }
  });
  it.each([`/${"x".repeat(4_096)}`, `/${"\u00e9".repeat(1_100)}`])(
    "keeps oversized URL failures visible (%#)",
    async (url) => {
      const messages = augmentChatHistoryWithCanvasBlocks([
        {
          role: "toolResult",
          toolName: "canvas",
          content: JSON.stringify({ kind: "canvas", view: { url } }),
        },
        { ...message(2), content: [{ type: "text", text: "Canvas result" }] },
      ]);
      const harness = createHarness(
        { status: "connected", epoch: 1 },
        { history: { messages, completeSnapshot: true } },
      );
      const { model, conversation } = await activatedConversation(harness);
      try {
        expect(conversation.getSnapshot().artifacts).toMatchObject([
          {
            state: "failed",
            error: { code: "ARTIFACT_MALFORMED" },
            source: { messageId: "message-2" },
          },
        ]);
      } finally {
        model.dispose();
      }
    },
  );
});
