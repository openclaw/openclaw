/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

const message = {
  role: "user",
  content: "Please review the release fixes.",
  __openclaw: { id: "original", senderIsOwner: true },
};
const viewers = [
  { userId: "alex", userName: "Alex", userAvatar: "AV" },
  { userId: "maya", userName: "Maya", userAvatar: "MV" },
  { userId: null, userName: null, userAvatar: null },
];
const container = document.createElement("div");

function groupFor(input: unknown) {
  const [group] = groupMessages([{ kind: "message", key: "saved-input", message: input }]);
  if (group?.kind !== "group") {
    throw new Error("Expected a visible input group");
  }
  return group;
}

afterEach(() => render(nothing, container));

it.each(["gutter", "footer"] as const)(
  "shows an owner-only input as Message without a %s avatar for every viewer",
  (avatarPlacement) => {
    const original = structuredClone(message);
    for (const viewer of viewers) {
      render(
        renderMessageGroup(groupFor(message), {
          showReasoning: false,
          showToolCalls: true,
          showOwnSenderName: false,
          avatarPlacement,
          ...viewer,
        }),
        container,
      );
      expect(container.querySelector(".chat-sender-name")?.textContent).toBe("Message");
      expect(
        container.querySelector(".chat-avatar, .chat-author-avatar, a.chat-sender-name"),
      ).toBeNull();
      expect(container.querySelector(".chat-group--peer")).toBeNull();
      expect(container.querySelector(".chat-text")?.textContent).toContain(message.content);
    }
    expect(message).toEqual(original);
  },
);

it.each([
  { senderId: "alex", senderName: "Recorded author" },
  {
    senderId: "alex",
    senderName: "Recorded author",
    senderIdentity: {
      type: "observation",
      pluginId: "discord",
      accountId: "work",
      senderKind: "human",
      id: "alex",
    },
  },
])("keeps unqualified and remote senders distinct from a matching viewer", (sender) => {
  render(
    renderMessageGroup(groupFor({ ...message, __openclaw: sender }), {
      showReasoning: false,
      showToolCalls: true,
      ...viewers[0],
    }),
    container,
  );
  expect(container.querySelector(".chat-sender-name")?.textContent).toBe("Recorded author");
  expect(container.querySelector(".chat-avatar")?.textContent?.trim()).toBe("RA");
  expect(container.querySelector("a.chat-sender-name, img")).toBeNull();
});

it.each(["loaded", "fetched"] as const)(
  "labels %s reply previews without borrowing the viewer",
  (location) => {
    const props = { ...viewers[0], assistantName: "OpenClaw" };
    const chain = projectTranscriptChain([groupFor(message)], {
      sessionKey: "agent:main:historical",
      runWorking: false,
      searchActive: false,
    });
    const loaded =
      location === "loaded"
        ? projectTranscriptIndex(chain, new Map(), props).loadedReplySources
        : new Map<string, LoadedReplySource>();
    const resolve = createReplyPreviewResolver(loaded, {
      ...props,
      replyMessageAccess: {
        revision: 0,
        navigationId: null,
        read: () => message,
        request: () => undefined,
        open: () => undefined,
      },
    });
    expect(resolve("original")).toMatchObject({ senderLabel: "Message", text: message.content });
  },
);
