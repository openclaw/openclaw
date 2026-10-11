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

it.each([
  { name: "owner-only gutter", avatarPlacement: "gutter", sender: undefined },
  { name: "owner-only footer", avatarPlacement: "footer", sender: undefined },
  {
    name: "unqualified sender",
    avatarPlacement: "gutter",
    sender: { senderId: "alex", senderName: "Recorded author" },
  },
  {
    name: "remote sender",
    avatarPlacement: "gutter",
    sender: {
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
  },
] as const)("does not borrow the viewer's identity for $name", ({ avatarPlacement, sender }) => {
  const input = sender ? { ...message, __openclaw: sender } : message;
  const original = structuredClone(input);
  for (const viewer of sender ? [viewers[0]] : viewers) {
    render(
      renderMessageGroup(groupFor(input), {
        showReasoning: false,
        showToolCalls: true,
        showOwnSenderName: false,
        avatarPlacement,
        ...viewer,
      }),
      container,
    );
    expect(container.querySelector(".chat-sender-name")?.textContent).toBe(
      sender ? "Recorded author" : "Message",
    );
    expect(container.querySelector("a.chat-sender-name, img")).toBeNull();
    if (sender) {
      expect(container.querySelector(".chat-avatar")?.textContent?.trim()).toBe("RA");
    } else {
      expect(container.querySelector(".chat-avatar, .chat-author-avatar")).toBeNull();
      expect(container.querySelector(".chat-group--peer")).toBeNull();
      expect(container.querySelector(".chat-text")?.textContent).toContain(message.content);
    }
  }
  expect(input).toEqual(original);
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
        open: () => undefined,
      },
    });
    expect(resolve("original")).toMatchObject({ senderLabel: "Message", text: message.content });
  },
);
