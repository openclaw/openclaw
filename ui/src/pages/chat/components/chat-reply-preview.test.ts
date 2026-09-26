/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";
import type { LoadedReplySource } from "./chat-reply-preview.types.ts";

describe("attachment reply previews", () => {
  it.each([
    { location: "loaded", caption: "" },
    { location: "fetched", caption: "" },
    { location: "loaded", caption: "Please review this report" },
    { location: "fetched", caption: "Please review this report" },
  ])(
    "resolves document-only content and its caption in $location history: $caption",
    ({ location, caption }) => {
      const sourceId = "document-source";
      const source = {
        role: "assistant",
        content: [
          ...(caption ? [{ type: "text", text: caption }] : []),
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
        text: caption || "report.pdf",
      });
    },
  );
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
});
