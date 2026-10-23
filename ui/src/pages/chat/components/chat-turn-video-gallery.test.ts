/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { buildCachedChatItems, resetChatThreadState } from "../chat-thread.ts";
import * as turnBoundary from "../chat-turn-boundary.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { projectTurnVideoMessages } from "./chat-turn-video-gallery.ts";

const container = document.createElement("div");
afterEach(() => {
  cleanupSolid();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetChatThreadState();
});

const forwardedSource = { kind: "inter_session", sourceTool: "sessions_send" };
const streamMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const messageKeys = (index: ReturnType<typeof projectTurnVideoMessages>, key: string) =>
  index.get(key)?.map((entry) => entry.key);

function group(key: string, role = "assistant", extra: Partial<MessageGroup> = {}) {
  const message = { role, content: key };
  return createMessageGroup(message, role, {
    key,
    messages: [{ key, message }],
    ...extra,
  });
}

it("retains turn membership across renders and stream deltas while reading fresh stream text", () => {
  const input = {
    paneId: "video-pane",
    sessionKey: "video-session",
    messages: [{ role: "assistant", content: "Saved clip", timestamp: 1 }],
    toolMessages: [],
    streamSegments: [],
    stream: "First clip",
    streamStartedAt: 2,
    showToolCalls: true,
  };
  const items = buildCachedChatItems(input);
  const byMessage = projectTurnVideoMessages(items);
  const live = items.find((item) => item.kind === "stream");
  expect(live?.kind).toBe("stream");
  const key = live!.key;
  const firstMessage = byMessage.get(key)!.at(-1)!.message;
  const boundary = vi.spyOn(turnBoundary, "chatItemStartsUserTurn");

  projectTurnVideoMessages(buildCachedChatItems(input));
  const next = projectTurnVideoMessages(buildCachedChatItems({ ...input, stream: "Second clip" }));
  expect(boundary).not.toHaveBeenCalled();
  expect(next.get(key)?.map((entry) => entry.message)).toEqual([
    input.messages[0],
    streamMessage("Second clip"),
  ]);
  expect(firstMessage).toEqual(streamMessage("First clip"));

  // A full build can preserve its array; its generation still owns invalidation.
  boundary.mockClear();
  const rebuilt = buildCachedChatItems({ ...input, stream: "Second clip", queue: [] });
  expect(rebuilt).toBe(items);
  projectTurnVideoMessages(rebuilt);
  expect(boundary).toHaveBeenCalled();

  const replacement = { ...input.messages[0], provenance: forwardedSource };
  const replaced = projectTurnVideoMessages(
    buildCachedChatItems({ ...input, messages: [replacement], stream: "Second clip" }),
  );
  expect(messageKeys(replaced, key)).toEqual([key]);
});

it("projects a whole turn across run frames, but never another user turn, divider, or forwarded session", () => {
  const a = group("a", "assistant", { runId: "run-a" });
  const b = group("b", "assistant", { runId: "run-b" });
  const index = projectTurnVideoMessages([
    group("user", "user"),
    a,
    group("tool", "tool"),
    b,
    group("next-user", "user"),
    group("c"),
    { kind: "divider", key: "divider", timestamp: 1, label: "Boundary" },
    group("d"),
    group("forwarded", "assistant", { senderSession: { sessionKey: "other-session" } }),
    group("e"),
  ]);
  expect(["a", "b"].map((key) => messageKeys(index, key))).toEqual([
    ["a", "b"],
    ["a", "b"],
  ]);
  expect(["c", "d", "e"].map((key) => messageKeys(index, key))).toEqual([["c"], ["d"], ["e"]]);
  expect([index.has("forwarded"), index.has("tool")]).toEqual([false, false]);
  const provenanceOnly = group("foreign");
  provenanceOnly.messages[0]!.message = {
    role: "assistant",
    content: "Foreign video",
    provenance: forwardedSource,
  };
  const forwarded = projectTurnVideoMessages([a, provenanceOnly, b]);
  expect(forwarded.has("foreign")).toBe(false);
  expect(["a", "b"].map((key) => messageKeys(forwarded, key))).toEqual([["a"], ["b"]]);
});

it("keeps duplicate video slots and each sibling message's source authority, but not persisted mirrors", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const source = `/tmp/openclaw/${crypto.randomUUID()}-repeated.mp4`;
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({
      available: true,
      mediaTicket: "gallery-ticket",
      mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const clip = (label: string) => createAttachmentBlock(source, "video", label, "video/mp4");
  const clipMessage = (
    id: string,
    content: unknown,
    media?: { path: string; contentType: string }[],
  ) => createAssistantMessage(content, { __openclaw: { id, ...(media && { media }) } });
  const message = clipMessage(
    "first-video-message",
    [clip("Repeated"), { type: "text", text: "Between clips" }, clip("Repeated")],
    [{ path: source, contentType: "video/mp4" }],
  );
  const sibling = clipMessage("last-video-message", [clip("Last")]);
  const turn = [
    { key: "first", message },
    { key: "last", message: sibling },
  ];
  let opened: ImageLightboxItem | undefined;
  document.body.append(container);
  const harness = createMessageGroupHarness(container);
  const renderedGroup = createMessageGroup(message, "assistant", {
    messages: [{ key: "first", message }],
  });
  onTestFinished(() => releaseChatMediaResourceOwner(harness));
  harness.render(renderedGroup, {
    showReasoning: false,
    showToolCalls: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    sessionKey: "agent:main:video-gallery",
    mediaOwner: harness,
    getTurnVideoMessages: () => turn,
    onOpenImage: (item) => {
      opened = item;
    },
  });
  await waitForSolid(() =>
    expect(container.querySelectorAll("openclaw-chat-video-player")).toHaveLength(2),
  );
  const players = [...container.querySelectorAll("openclaw-chat-video-player")];
  expect(players).toHaveLength(2);
  await Promise.all(players.map((player) => player.updateComplete));
  players[1]!.onExpand?.(source);
  expect(opened?.gallery?.index).toBe(1);
  const entries = await Promise.all(opened!.gallery!.items.map((load) => load()));
  expect(entries.map((item) => item?.title)).toEqual(["Repeated", "Repeated", "Last"]);
  expect(entries.every((item) => item?.kind === "video" && item.connectVideo)).toBe(true);
  const expectedMessageIds = ["first-video-message", "first-video-message", "last-video-message"];
  for (const [index, item] of entries.entries()) {
    const video = document.createElement("video");
    const disconnect = item!.connectVideo!(video, vi.fn());
    try {
      await vi.advanceTimersByTimeAsync(0);
      const params = new URL(video.src).searchParams;
      expect(Object.fromEntries(params)).toMatchObject({
        mediaTicket: "gallery-ticket",
        source,
        messageId: expectedMessageIds[index],
        sessionKey: "agent:main:video-gallery",
      });
    } finally {
      disconnect();
    }
  }
  expect(
    fetchMock.mock.calls.map(([url]) =>
      new URL(url instanceof Request ? url.url : url, window.location.origin).searchParams.get(
        "messageId",
      ),
    ),
  ).toEqual(["first-video-message", "last-video-message"]);
});
