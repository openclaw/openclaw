/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { renderMessageGroup } from "./chat-message.ts";
import { projectTurnVideoMessages } from "./chat-turn-video-gallery.ts";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
});

function group(key: string, role = "assistant", extra: Partial<MessageGroup> = {}) {
  return createMessageGroup({ role, content: key }, role, {
    key,
    messages: [{ key, message: { role, content: key } }],
    ...extra,
  });
}

it("projects a whole turn across run frames, but never another user turn, divider, or forwarded session", () => {
  const a = group("a", "assistant", { runId: "run-a" });
  const b = group("b", "assistant", { runId: "run-b" });
  const c = group("c");
  const d = group("d");
  const e = group("e");
  const index = projectTurnVideoMessages([
    group("user", "user"),
    a,
    group("tool", "tool"),
    b,
    group("next-user", "user"),
    c,
    { kind: "divider", key: "divider", timestamp: 1, label: "Boundary" },
    d,
    group("forwarded", "assistant", { senderSession: { sessionKey: "other-session" } }),
    e,
  ]);
  expect(index.get("a")?.map((entry) => entry.key)).toEqual(["a", "b"]);
  expect(index.get("b")?.map((entry) => entry.key)).toEqual(["a", "b"]);
  expect(index.get("c")?.map((entry) => entry.key)).toEqual(["c"]);
  expect(index.get("d")?.map((entry) => entry.key)).toEqual(["d"]);
  expect(index.get("e")?.map((entry) => entry.key)).toEqual(["e"]);
  expect(index.has("forwarded")).toBe(false);
  expect(index.has("tool")).toBe(false);
  const provenanceOnly = group("forwarded-provenance", "assistant", {
    messages: [
      {
        key: "foreign",
        hasVisibleContent: true,
        message: {
          role: "assistant",
          content: "Foreign video",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        },
      },
    ],
  });
  const forwarded = projectTurnVideoMessages([a, provenanceOnly, b]);
  expect(forwarded.has("foreign")).toBe(false);
  expect(forwarded.get("a")?.map((entry) => entry.key)).toEqual(["a"]);
  expect(forwarded.get("b")?.map((entry) => entry.key)).toEqual(["b"]);
});

it("keeps duplicate positioned video slots and sibling messages, but not persisted mirrors", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const source = "https://example.com/repeated.mp4";
  const message = createAssistantMessage(
    [
      createAttachmentBlock(source, "video", "Repeated", "video/mp4"),
      { type: "text", text: "Between clips" },
      createAttachmentBlock(source, "video", "Repeated", "video/mp4"),
    ],
    { __openclaw: { media: [{ path: source, contentType: "video/mp4" }] } },
  );
  const sibling = createAssistantMessage([
    createAttachmentBlock("https://example.com/last.mp4", "video", "Last", "video/mp4"),
  ]);
  const turn = [
    { key: "first", message },
    { key: "last", message: sibling },
  ];
  let opened: ImageLightboxItem | undefined;
  document.body.append(container);
  render(
    renderMessageGroup(
      createMessageGroup(message, "assistant", { messages: [{ key: "first", message }] }),
      {
        showReasoning: false,
        showToolCalls: false,
        assistantName: "OpenClaw",
        assistantAvatar: null,
        getTurnVideoMessages: () => turn,
        onOpenImage: (item) => {
          opened = item;
        },
      },
    ),
    container,
  );
  const players = [...container.querySelectorAll("openclaw-chat-video-player")];
  expect(players).toHaveLength(2);
  await Promise.all(players.map((player) => player.updateComplete));
  players[1]!.onExpand?.(source);
  expect(opened?.gallery?.index).toBe(1);
  const entries = await Promise.all(opened!.gallery!.items.map((load) => load()));
  expect(entries.map((item) => item?.title)).toEqual(["Repeated", "Repeated", "Last"]);
  expect(entries.every((item) => item?.kind === "video" && item.connectVideo)).toBe(true);
});
