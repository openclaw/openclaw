/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";

function preview(
  source: unknown,
  location: "loaded" | "fetched",
  senderLabel: string,
  props: Partial<Parameters<typeof createReplyPreviewResolver>[1]> = {},
) {
  const loaded = new Map<string, LoadedReplySource>();
  if (location === "loaded") {
    loaded.set("source", { message: source, messageId: "source-row", senderLabel });
  }
  return createReplyPreviewResolver(loaded, {
    assistantName: "OpenClaw",
    ...props,
    replyMessageAccess: { read: () => (location === "fetched" ? source : undefined) },
  })("source");
}

const identity = { type: "profile", id: "mira" } as const;
const attachment = {
  kind: "document",
  url: "https://files.example.test/report.pdf",
  label: "report.pdf",
  mimeType: "application/pdf",
};
const documentSource = {
  role: "assistant",
  __openclaw: { id: "source" },
  content: [{ type: "attachment", attachment }],
};
const photoSource = {
  role: "user",
  content: [],
  __openclaw: { id: "source", senderId: "mira", senderName: "Mira", senderIdentity: identity },
};
it.each([
  ...(["loaded", "fetched"] as const).flatMap((location) => [
    [location, documentSource, "OpenClaw", "report.pdf"] as const,
    [location, photoSource, "Mira", ""] as const,
  ]),
  ["fetched", { role: "user", content: [] }, "", undefined] as const,
])("keeps textless persisted sources (%s, %j, %s)", (location, source, senderLabel, text) => {
  const actual = preview(source, location, senderLabel);
  if (text === undefined) {
    expect(actual).toBeUndefined();
  } else {
    expect(actual).toMatchObject({
      sourceMessageId: "source",
      senderLabel,
      text,
      ...(source === photoSource ? { sender: { id: "mira", name: "Mira", identity } } : {}),
    });
  }
});

function agentSource(agentId?: string, metadata: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: "The original answer",
    ...(agentId ? { senderSession: { sessionKey: `agent:${agentId}:main`, agentId } } : {}),
    __openclaw: { id: "source", ...metadata },
  };
}
const reviewer = {
  senderId: "reviewer",
  senderName: "Source author",
  senderIdentity: { type: "profile", id: "reviewer" },
} as const;

it.each([
  ["loaded", "main", "image", "/avatars/current.png", null],
  ["loaded", "main", "text", null, "🦀"],
  ["loaded", "research", "image", "/avatars/research.png", null],
  ["loaded", "research", "text", null, "🌙"],
  ["loaded", "research", "roster", "/avatars/roster.png", null],
  ["fetched", "research", "roster", "/avatars/research.png", null],
  ["fetched", "research", "missing", null, null],
  ["fetched", undefined, "image", "/avatars/current.png", null],
  ["loaded", undefined, "profile", "/avatars/current.png", null],
] as const)(
  "preserves the source owner's identity and avatar (%s, %s, %s)",
  (location, agentId, kind, avatar, textAvatar) => {
    const profile = kind === "profile";
    const image = kind === "image" || profile;
    const source = agentSource(agentId, profile ? reviewer : {});
    const rosterAvatar = location === "fetched" ? "/avatars/research.png" : "/avatars/roster.png";
    const researchIdentity =
      kind === "text" || profile ? { emoji: "🌙" } : { avatarUrl: rosterAvatar };
    const label = profile ? "Source author" : "Source agent";
    const actual = preview(source, location, label, {
      assistantName: "Current agent",
      currentAgentId: "main",
      assistantAvatar: kind === "image" ? "/avatars/current.png" : "🦀",
      assistantAvatarUrl: image ? "/avatars/current.png" : null,
      agents:
        kind === "missing" || (!agentId && !profile)
          ? []
          : [
              { id: "main", identity: {} },
              { id: "research", identity: researchIdentity },
            ],
      senderAgentAvatars: new Map([["research", image ? "/avatars/research.png" : null]]),
    });
    if (profile) {
      expect(actual).toMatchObject({
        sender: { identity: reviewer.senderIdentity, name: "Source author" },
      });
    } else {
      expect(actual).toMatchObject({
        sender: { identity: { type: "agent", id: agentId ?? "main" } },
        agentAvatar: {
          avatar,
          textAvatar,
          ...(location === "fetched" ? { id: agentId ?? "main" } : {}),
        },
      });
    }
  },
);

it.each([
  { roster: { name: "Research" }, name: "Research" },
  { roster: {}, name: undefined },
])("names a fetched source by its own agent, never the viewing one ($name)", ({ roster, name }) => {
  const actual = preview(agentSource("research"), "fetched", "", {
    currentAgentId: "main",
    agents: [{ id: "research", identity: roster }],
  });
  expect(actual).toMatchObject({
    sender: { identity: { type: "agent", id: "research" } },
    agentAvatar: { id: "research" },
  });
  const named = actual && "sender" in actual ? actual : undefined;
  expect([named?.senderLabel ?? undefined, named?.sender?.name]).toEqual([name, name]);
});
