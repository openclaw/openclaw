/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";

function preview(
  source: unknown,
  location: "loaded" | "fetched",
  senderLabel: string,
  props: Partial<Parameters<typeof createReplyPreviewResolver>[1]> = {},
) {
  return createReplyPreviewResolver(
    new Map<string, LoadedReplySource>(
      location === "loaded"
        ? [["source", { message: source, messageId: "source-row", senderLabel }]]
        : [],
    ),
    {
      assistantName: "OpenClaw",
      ...props,
      replyMessageAccess: { read: () => (location === "fetched" ? source : undefined) },
    },
  )("source");
}

const identity = { type: "profile", id: "mira" } as const;
const documentSource = {
  role: "assistant",
  __openclaw: { id: "source" },
  content: [
    {
      type: "attachment",
      attachment: {
        kind: "document",
        url: "https://files.example.test/report.pdf",
        label: "report.pdf",
        mimeType: "application/pdf",
      },
    },
  ],
};
const photoSource = {
  role: "user",
  content: [],
  __openclaw: { id: "source", senderId: "mira", senderName: "Mira", senderIdentity: identity },
};
it.each([
  ...(["loaded", "fetched"] as const).flatMap((location) => [
    {
      location,
      source: documentSource,
      senderLabel: "OpenClaw",
      expected: {
        sourceMessageId: "source",
        senderLabel: "OpenClaw",
        text: "report.pdf",
      },
    },
    {
      location,
      source: photoSource,
      senderLabel: "Mira",
      expected: {
        sourceMessageId: "source",
        senderLabel: "Mira",
        sender: { id: "mira", name: "Mira", identity },
        text: "",
      },
    },
  ]),
  {
    location: "fetched" as const,
    source: { role: "user", content: [] },
    senderLabel: "",
    expected: undefined,
  },
])(
  "describes a textless source only with persisted content or identity ($location, $senderLabel)",
  ({ location, source, senderLabel, expected }) => {
    const actual = preview(source, location, senderLabel);
    if (expected) {
      expect(actual).toMatchObject(expected);
    } else {
      expect(actual).toBeUndefined();
    }
  },
);

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
    const typedIdentity = { type: "profile", id: "reviewer" } as const;
    const source = {
      role: "assistant",
      content: "The original answer",
      ...(agentId ? { senderSession: { sessionKey: `agent:${agentId}:main`, agentId } } : {}),
      __openclaw: {
        id: "source",
        ...(kind === "profile"
          ? {
              senderId: typedIdentity.id,
              senderName: "Source author",
              senderIdentity: typedIdentity,
            }
          : {}),
      },
    };
    const actual = preview(
      source,
      location,
      kind === "profile" ? "Source author" : "Source agent",
      {
        assistantName: "Current agent",
        currentAgentId: "main",
        assistantAvatar: kind === "image" ? "/avatars/current.png" : "🦀",
        assistantAvatarUrl: kind === "image" || kind === "profile" ? "/avatars/current.png" : null,
        agents:
          kind === "missing" || (!agentId && kind !== "profile")
            ? []
            : [
                { id: "main", identity: {} },
                {
                  id: "research",
                  identity:
                    kind === "text" || kind === "profile"
                      ? { emoji: "🌙" }
                      : {
                          avatarUrl:
                            location === "fetched"
                              ? "/avatars/research.png"
                              : "/avatars/roster.png",
                        },
                },
              ],
        senderAgentAvatars: new Map([
          ["research", kind === "image" || kind === "profile" ? "/avatars/research.png" : null],
        ]),
      },
    );
    if (kind === "profile") {
      expect(actual).toMatchObject({ sender: { identity: typedIdentity, name: "Source author" } });
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
  const actual = preview(
    {
      role: "assistant",
      content: "Findings",
      senderSession: { sessionKey: "agent:research:main", agentId: "research" },
      __openclaw: { id: "source" },
    },
    "fetched",
    "",
    { currentAgentId: "main", agents: [{ id: "research", identity: roster }] },
  );
  expect(actual).toMatchObject({ sender: { identity: { type: "agent", id: "research" } } });
  const named = actual && "sender" in actual ? actual : undefined;
  expect(named?.senderLabel ?? undefined).toBe(name);
  expect(named?.sender?.name).toBe(name);
  expect(named?.agentAvatar).toMatchObject({ id: "research" });
});
