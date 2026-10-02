/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";

describe("attachment reply previews", () => {
  it.each(["loaded", "fetched"] as const)(
    "describes a document-only source from %s history",
    (location) => {
      const sourceId = "document-source";
      const source = {
        role: "assistant",
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
        __openclaw: { id: sourceId },
      };
      const resolve = createReplyPreviewResolver(
        new Map<string, LoadedReplySource>(
          location === "loaded"
            ? [[sourceId, { message: source, messageId: sourceId, senderLabel: "OpenClaw" }]]
            : [],
        ),
        {
          assistantName: "OpenClaw",
          userId: null,
          userName: null,
          replyMessageAccess: {
            read: () => (location === "fetched" ? source : undefined),
          },
        },
      );

      expect(resolve(sourceId)).toMatchObject({
        sourceMessageId: sourceId,
        senderLabel: "OpenClaw",
        text: "report.pdf",
      });
    },
  );
});

describe("text-less reply previews", () => {
  const identity = { type: "profile", id: "mira" } as const;
  const source = {
    role: "user",
    content: [],
    __openclaw: { id: "photo", senderId: "mira", senderName: "Mira", senderIdentity: identity },
  };

  it.each(["loaded", "fetched"] as const)(
    "keeps the sender of a persisted original without text from %s history",
    (location) => {
      const resolve = createReplyPreviewResolver(
        new Map<string, LoadedReplySource>(
          location === "loaded"
            ? [["photo", { message: source, messageId: "photo-row", senderLabel: "Mira" }]]
            : [],
        ),
        {
          assistantName: "OpenClaw",
          replyMessageAccess: { read: () => (location === "fetched" ? source : undefined) },
        },
      );
      expect(resolve("photo")).toMatchObject({
        sourceMessageId: "photo",
        senderLabel: "Mira",
        sender: { id: "mira", name: "Mira", identity },
        text: "",
      });
    },
  );

  it("does not describe an unpersisted original without text", () => {
    const resolve = createReplyPreviewResolver(new Map(), {
      assistantName: "OpenClaw",
      replyMessageAccess: { read: () => ({ role: "user", content: [] }) },
    });
    expect(resolve("photo")).toBeUndefined();
  });
});

describe("quoted agent identity", () => {
  it("preserves a typed profile source without session provenance", () => {
    const identity = { type: "profile", id: "reviewer" } as const;
    const source = {
      role: "assistant",
      content: "The source answer",
      __openclaw: {
        id: "typed-source",
        senderId: identity.id,
        senderName: "Source author",
        senderIdentity: identity,
      },
    };
    const resolve = createReplyPreviewResolver(
      new Map([
        [
          "typed-source",
          { message: source, messageId: "typed-source", senderLabel: "Source author" },
        ],
      ]),
      {
        assistantName: "Current agent",
        currentAgentId: "main",
        assistantAvatarUrl: "/avatars/current.png",
        agents: [{ id: "research", identity: { emoji: "🌙" } }],
        senderAgentAvatars: new Map([["research", "/avatars/research.png"]]),
      },
    );
    expect(resolve("typed-source")).toMatchObject({
      sender: { identity, name: "Source author" },
    });
  });

  it.each([
    { agentId: "main", kind: "image", expectedImage: "/avatars/current.png", expectedText: null },
    { agentId: "main", kind: "text", expectedImage: null, expectedText: "🦀" },
    {
      agentId: "research",
      kind: "image",
      expectedImage: "/avatars/research.png",
      expectedText: null,
    },
    { agentId: "research", kind: "text", expectedImage: null, expectedText: "🌙" },
    {
      agentId: "research",
      kind: "roster-image",
      expectedImage: "/avatars/roster.png",
      expectedText: null,
    },
  ])(
    "uses the $agentId owner's configured $kind avatar with explicit session provenance",
    ({ agentId, kind, expectedImage, expectedText }) => {
      const source = {
        role: "assistant",
        content: "The original answer",
        senderSession: { sessionKey: `agent:${agentId}:main`, agentId },
        __openclaw: { id: "quoted-agent" },
      };
      const resolve = createReplyPreviewResolver(
        new Map([
          [
            "quoted-agent",
            { message: source, messageId: "quoted-agent", senderLabel: "Source agent" },
          ],
        ]),
        {
          assistantName: "Current agent",
          currentAgentId: "main",
          assistantAvatar: kind === "image" ? "/avatars/current.png" : "🦀",
          assistantAvatarUrl: kind === "image" ? "/avatars/current.png" : null,
          agents: [
            { id: "main", identity: {} },
            {
              id: "research",
              identity: kind === "text" ? { emoji: "🌙" } : { avatarUrl: "/avatars/roster.png" },
            },
          ],
          senderAgentAvatars: new Map([
            ["research", kind === "image" ? "/avatars/research.png" : null],
          ]),
        },
      );
      expect(resolve("quoted-agent")).toMatchObject({
        sender: { identity: { type: "agent", id: agentId } },
        agentAvatar: { avatar: expectedImage, textAvatar: expectedText },
      });
    },
  );

  it.each([
    { roster: { name: "Research" }, name: "Research" },
    { roster: {}, name: undefined },
  ])(
    "names another agent's fetched original by that agent, never the viewing one ($name)",
    ({ roster, name }) => {
      const source = {
        role: "assistant",
        content: "Findings",
        senderSession: { sessionKey: "agent:research:main", agentId: "research" },
        __openclaw: { id: "research-answer" },
      };
      const resolve = createReplyPreviewResolver(new Map(), {
        assistantName: "OpenClaw",
        currentAgentId: "main",
        agents: [{ id: "research", identity: roster }],
        replyMessageAccess: { read: () => source },
      });
      const preview = resolve("research-answer");
      expect(preview).toMatchObject({ sender: { identity: { type: "agent", id: "research" } } });
      const named = preview && "sender" in preview ? preview : undefined;
      expect(named?.senderLabel ?? undefined).toBe(name);
      expect(named?.sender?.name).toBe(name);
      expect(named?.agentAvatar).toMatchObject({ id: "research" });
    },
  );

  it.each([
    {
      agentId: "research",
      roster: [{ id: "research", identity: { avatarUrl: "/avatars/research.png" } }],
      expected: { id: "research", avatar: "/avatars/research.png", textAvatar: null },
    },
    {
      agentId: "research",
      roster: [],
      expected: { id: "research", avatar: null, textAvatar: null },
    },
    {
      agentId: undefined,
      roster: [],
      expected: { id: "main", avatar: "/avatars/current.png", textAvatar: null },
    },
  ])(
    "draws a fetched agent original with its own avatar, never the viewing agent's ($agentId, roster $roster.length)",
    ({ agentId, roster, expected }) => {
      // A Gateway `chat.message.get` result names another agent's message only by
      // its session provenance; its transcript metadata never carries an agent identity.
      const source = {
        role: "assistant",
        content: "Findings",
        ...(agentId ? { senderSession: { sessionKey: `agent:${agentId}:main`, agentId } } : {}),
        __openclaw: { id: "agent-answer" },
      };
      const resolve = createReplyPreviewResolver(new Map(), {
        assistantName: "OpenClaw",
        currentAgentId: "main",
        assistantAvatarUrl: "/avatars/current.png",
        agents: roster,
        replyMessageAccess: { read: () => source },
      });
      expect(resolve("agent-answer")).toMatchObject({
        sender: { identity: { type: "agent", id: expected.id } },
        agentAvatar: expected,
      });
    },
  );
});
