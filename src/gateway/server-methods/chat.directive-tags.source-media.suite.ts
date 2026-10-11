import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { buildSourceReplyPayloadState } from "../../agents/embedded-agent-runner/run/source-reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  type SessionTranscriptReadScope,
} from "../../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import { persistInternalSourceReply } from "../internal-source-reply-persistence.js";
import { resolveManagedOutgoingMediaArtifactDownload } from "../managed-image-attachments.js";
import { getMessage, getMessageContent, TINY_PNG_BASE64 } from "./chat-message.test-fixtures.js";

type SourceReply = { kind: "tool" | "block" | "final"; payload: ReplyPayload };

type SourceMediaFixture = {
  session: () => {
    cfg: OpenClawConfig;
    scope: SessionTranscriptReadScope & { sessionId: string };
    stateDir: string;
  };
  stageMediaPath: (path: string, contentType: string) => void;
  withTranscriptFixtureState: (
    prefix: string,
    run: (dir: string) => Promise<void>,
  ) => Promise<void>;
  readActiveAssistantTranscriptMessages: () => Promise<Array<Record<string, unknown>>>;
  readRawActiveAssistantTranscriptMessages: () => Promise<Array<Record<string, unknown>>>;
  appendSourceReplyMirrorEntry: (params: {
    text: string;
    idempotencyKey?: string;
    model?: string;
    provider?: string;
  }) => Promise<void>;
  createMainSourceReply: (params: {
    idempotencyKey: string;
    text?: string;
    mediaUrls?: string[];
    transcriptOwner?: true;
  }) => SourceReply;
  setAgentRunReplies: (replies: SourceReply[]) => void;
  send: (params: { idempotencyKey: string; message: string }) => Promise<unknown>;
  writeSavedPng: (dir: string, name: string) => string;
};

export function registerChatSourceMediaTests(fixture: SourceMediaFixture) {
  const {
    withTranscriptFixtureState,
    readActiveAssistantTranscriptMessages,
    readRawActiveAssistantTranscriptMessages,
    appendSourceReplyMirrorEntry,
    createMainSourceReply,
    setAgentRunReplies,
    writeSavedPng,
  } = fixture;
  it("reuses committed message-tool media after its tool result and final answer", async () => {
    await withTranscriptFixtureState("openclaw-chat-send-committed-source-media-", async (dir) => {
      const { cfg, scope, stateDir } = fixture.session();
      const mediaUrl = path.join(dir, "probe.txt");
      fs.writeFileSync(mediaUrl, "SOURCE-MEDIA-PROOF\n");
      const idempotencyKey = "source-media-run:message-tool:send";
      const sessionKey = "agent:main:main";
      const payload: ReplyPayload = {
        mediaUrls: [mediaUrl],
        attachments: [{ name: "probe.txt", mimeType: "text/plain" }],
        trustedLocalMedia: true,
      };
      await persistInternalSourceReply({
        cfg,
        agentId: "main",
        sessionKey,
        expectedSessionId: scope.sessionId,
        idempotencyKey,
        payload,
        sourceReplyFinal: true,
      });
      const committed = (await readActiveAssistantTranscriptMessages())[0];
      const attachment = asOptionalRecord(getMessageContent({ message: committed })[0]?.attachment);
      expect(attachment).toMatchObject({ label: "probe.txt", mimeType: "text/plain" });
      await appendTranscriptMessage(scope, {
        message: {
          role: "toolResult",
          toolCallId: "send",
          toolName: "message",
          content: [
            { type: "text", text: "Sent visible reply to the current source conversation." },
          ],
        },
      });
      await appendSourceReplyMirrorEntry({
        idempotencyKey: "source-media-run:assistant",
        provider: "openai",
        model: "gpt-5.6-luna",
        text: "The attachment is ready.",
      });
      const before = loadTranscriptEventsSync(scope);
      fixture.stageMediaPath(mediaUrl, "text/plain");
      const source = buildSourceReplyPayloadState({
        sessionKey,
        agentId: "main",
        payloads: [{ ...payload, idempotencyKey, transcriptOwner: true }],
      });
      setAgentRunReplies(source.replyItems.map((reply) => ({ kind: "final", payload: reply })));
      const broadcast = await fixture.send({
        idempotencyKey: "source-media-run",
        message: "Send the probe attachment.",
      });
      expect(getMessageContent(broadcast)).toEqual(committed?.content);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
      const previousConfig = getRuntimeConfigSnapshot();
      setRuntimeConfigSnapshot(cfg);
      try {
        await expect(
          resolveManagedOutgoingMediaArtifactDownload({
            sessionKey,
            agentId: "main",
            artifactId: String(attachment?.artifactId),
            stateDir,
          }),
        ).resolves.toMatchObject({ type: "file", title: "probe.txt", sizeBytes: 19 });
      } finally {
        if (previousConfig) {
          setRuntimeConfigSnapshot(previousConfig);
        } else {
          clearRuntimeConfigSnapshot();
        }
      }
    });
  });

  it("backs source reply media with an equivalent deduped delivery mirror", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-deduped-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        const replyText = "Source reply with media";
        writeSavedPng(fixtureDir, "source-reply-deduped.png");
        const mirrorIdempotencyKey = "idem-agent-source-reply-deduped:internal-source-reply:0";
        await appendSourceReplyMirrorEntry({
          text:
            resolveMirroredTranscriptText({ text: replyText, mediaUrls: [mediaUrl] }) ?? "media",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: mirrorIdempotencyKey,
            text: replyText,
            mediaUrls: [mediaUrl],
          }),
        ]);
        const broadcast = await fixture.send({
          idempotencyKey: "idem-agent-source-reply-deduped",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(1);
        expect(JSON.stringify(broadcastContent)).toContain("/api/chat/media/outgoing/");
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
        for (const message of [
          assistantEntries[0],
          ...(await readRawActiveAssistantTranscriptMessages()),
        ]) {
          expect(getMessageContent({ message }).filter((block) => block.type === "text")).toEqual([
            { type: "text", text: replyText },
          ]);
        }
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
      },
    );
  });

  it("keeps backed media source replies when a sibling mirror is missing", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-partial-",
      async (fixtureDir) => {
        const firstMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        const secondMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-backed.png");
        writeSavedPng(fixtureDir, "source-reply-missing.png");
        const backedMirrorKey = "idem-agent-source-reply-partial:internal-source-reply:0";
        const missingMirrorKey = "idem-agent-source-reply-partial:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: backedMirrorKey,
          text: "Backed source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: backedMirrorKey,
            text: "Backed source reply",
            mediaUrls: [firstMediaUrl],
          }),
          createMainSourceReply({
            idempotencyKey: missingMirrorKey,
            text: "Missing mirror source reply",
            mediaUrls: [secondMediaUrl],
          }),
        ]);
        const broadcast = await fixture.send({
          idempotencyKey: "idem-agent-source-reply-partial",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(1);
        expect(extractFirstTextBlock(getMessage(broadcast))).toBe("Backed source reply");
        expect(String(broadcastContent[1]?.url)).toContain("/api/chat/media/outgoing/");
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.idempotencyKey).toBe(backedMirrorKey);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(firstMediaUrl);
        expect(JSON.stringify(broadcastContent)).not.toContain(secondMediaUrl);
      },
    );
  });

  it.each(["colliding key", "later transcript entry", "owned colliding key"] as const)(
    "does not rewrite source media across a %s",
    async (reason) => {
      await withTranscriptFixtureState(
        "openclaw-chat-send-source-rewrite-refusal-",
        async (fixtureDir) => {
          const collision = reason !== "later transcript entry";
          const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
          writeSavedPng(fixtureDir, "source-reply.png");
          const mirrorKey = "idem-source-rewrite-refusal:internal-source-reply:0";
          const text = collision ? "Existing assistant content" : "Source reply with media";
          await appendSourceReplyMirrorEntry({
            idempotencyKey: mirrorKey,
            text,
            ...(collision ? { model: "gateway-injected" } : {}),
          });
          if (!collision) {
            await appendSourceReplyMirrorEntry({
              idempotencyKey: "later-assistant-entry",
              text: "Later assistant content",
              model: "gateway-injected",
            });
          }
          setAgentRunReplies([
            createMainSourceReply({
              idempotencyKey: mirrorKey,
              text: "Source reply with media",
              mediaUrls: [mediaUrl],
              ...(reason === "owned colliding key" ? { transcriptOwner: true } : {}),
            }),
          ]);
          const broadcast = await fixture.send({
            idempotencyKey: "idem-source-rewrite-refusal",
            message: "hello from codex",
          });
          expect(JSON.stringify(getMessageContent(broadcast))).not.toContain(
            "/api/chat/media/outgoing/",
          );
          const entries = await readActiveAssistantTranscriptMessages();
          expect(entries[0]?.content).toStrictEqual([{ type: "text", text }]);
          if (collision) {
            expect(entries).toHaveLength(1);
            expect(entries[0]?.model).toBe("gateway-injected");
          } else {
            expect(entries.map((entry) => entry.idempotencyKey)).toStrictEqual([
              mirrorKey,
              "later-assistant-entry",
            ]);
            expect(entries[1]?.content).toStrictEqual([
              { type: "text", text: "Later assistant content" },
            ]);
          }
        },
      );
    },
  );

  it("keeps a placeholder for unbacked media-only source reply siblings", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-media-only-sibling-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-media-only-sibling.png");
        const textMirrorKey = "idem-agent-source-reply-media-only-sibling:internal-source-reply:0";
        const missingMirrorKey =
          "idem-agent-source-reply-media-only-sibling:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: textMirrorKey,
          text: "Text source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: textMirrorKey,
            text: "Text source reply",
            transcriptOwner: true,
          }),
          createMainSourceReply({ idempotencyKey: missingMirrorKey, mediaUrls: [mediaUrl] }),
        ]);
        const broadcast = await fixture.send({
          idempotencyKey: "idem-agent-source-reply-media-only-sibling",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent).toContainEqual({ type: "text", text: "Text source reply" });
        expect(broadcastContent).toContainEqual({
          type: "text",
          text: "Media reply could not be displayed.",
        });
        const broadcastJson = JSON.stringify(broadcast);
        expect(broadcastJson).not.toContain("MEDIA:");
        expect(broadcastJson).not.toContain(mediaUrl);
        expect(broadcastJson).not.toContain("/api/chat/media/outgoing/");
      },
    );
  });
}
