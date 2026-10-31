import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  type SessionAccessScope,
} from "../config/sessions/session-accessor.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import { getMediaDir } from "../media/store.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createChatVisionModelCatalogSnapshot,
  createDirectChatContext,
} from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { callDirectChat } from "./server.chat-direct-handler.test-support.js";
import { CHAT_DOT_PNG_BASE64, INLINE_DOT_PNG_IMAGE } from "./server.chat-image.test-support.js";
import {
  captureChatResponse,
  type CapturedChatResponse,
} from "./server.chat-response.test-support.js";
import { writeStoredMainSession } from "./server.chat-session-store.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";

export function registerChatAdmittedMediaTests(harness: {
  withChatSession: (
    run: (scope: SessionAccessScope & { agentId: string; sessionId: string }) => Promise<void>,
  ) => Promise<void>;
  settle: () => Promise<void> | undefined;
}) {
  test("chat.send retains durably admitted media when later setup throws before the ACK", async () => {
    await harness.withChatSession(async (scope) => {
      await writeStoredMainSession({ modelProvider: "test-provider", model: "vision-model" });
      const context = createDirectChatContext({
        // addChatRun runs after durable input admission but before the ACK.
        addChatRun: vi.fn(() => {
          throw new Error("setup exploded before ack");
        }),
      });
      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "chat.send",
        context,
        params: {
          sessionKey: "main",
          message: "setup error with media",
          idempotencyKey: "idem-setup-error-media",
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("offloaded inbound media").toString("base64"),
            },
          ],
        },
        client: {
          connId: "conn-owner",
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              version: "1.0.0",
              platform: "node",
            },
            device: { id: "dev-owner" },
            scopes: ["operator.write"],
          },
        } as never,
        respond: captureChatResponse(responses),
      });
      expect(responses).toEqual([
        {
          ok: false,
          payload: expect.objectContaining({ status: "error" }),
          error: expect.anything(),
        },
      ]);
      await harness.settle();
      expect(await listSessionPendingInputs(scope)).toEqual({ total: 0, items: [] });
      const messages = loadTranscriptEventsSync(scope).flatMap((event) =>
        isRecord(event) && isRecord(event.message) && event.message.role === "user"
          ? [event.message]
          : [],
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "setup error with media",
        idempotencyKey: "idem-setup-error-media:user",
      });
      const media = readPersistedMediaFacts(
        expectDefined(messages[0], "Expected the committed input"),
      );
      expect(media).toHaveLength(1);
      const retainedUrl = expectDefined(media?.[0]?.url, "Expected the committed attachment URL");
      expect(retainedUrl).toMatch(/^media:\/\/inbound\//);
      const retainedPath = await resolveMediaReferenceLocalPath(retainedUrl);
      await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("offloaded inbound media");
      const remaining = await fs.readdir(inboundDir);
      expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([
        path.basename(retainedPath),
      ]);
    });
  });

  test.each([true, false])(
    "chat.send keeps managed image uploads without duplicating vision input (vision=%s)",
    async (vision) => {
      await harness.withChatSession(async () => {
        try {
          const provider = vision ? "test-provider" : "anthropic";
          const model = vision ? "vision-model" : "claude-opus-4-6";
          testState.agentConfig = vision
            ? { model: { primary: provider + "/" + model } }
            : {
                model: {
                  primary: "anthropic/claude-opus-4-6",
                  fallbacks: ["anthropic/claude-haiku-4-6"],
                },
                imageModel: { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] },
                models: { "anthropic/claude-opus-4-6": {} },
              };
          await writeStoredMainSession({ modelProvider: provider, model });
          const context = createDirectChatContext(
            vision
              ? {
                  getRuntimeConfig,
                  loadGatewayModelCatalogSnapshot: vi
                    .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
                    .mockResolvedValue(createChatVisionModelCatalogSnapshot()),
                }
              : {
                  getRuntimeConfig,
                  loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
                    async () => [
                      {
                        id: "claude-opus-4-6",
                        name: "Claude Opus 4.6",
                        provider: "anthropic",
                        input: ["text"],
                      },
                      {
                        id: "gpt-4o",
                        name: "GPT-4o",
                        provider: "openai",
                        input: ["text", "image"],
                      },
                      {
                        id: "gpt-4o-mini",
                        name: "GPT-4o mini",
                        provider: "openai",
                        input: ["text", "image"],
                      },
                      {
                        id: "claude-haiku-4-6",
                        name: "Claude Haiku 4.6",
                        provider: "anthropic",
                        input: ["text"],
                      },
                    ],
                  ),
                },
          );
          const idempotencyKey = vision
            ? "idem-inline-image-managed-media"
            : "idem-configured-image-model-with-image-fallback";
          const captured = createDeferred<{
            ctx: MsgContext;
            replyOptions?: GetReplyOptions;
          }>();
          dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
            const params = args as { ctx: MsgContext; replyOptions?: GetReplyOptions };
            expect(params.replyOptions?.runId).toBe(idempotencyKey);
            captured.resolve(params);
          });
          const responses: CapturedChatResponse[] = [];
          await callDirectChat("chat.send", {
            id: "chat.send",
            context,
            params: {
              sessionKey: "main",
              message: "inspect the uploaded file",
              idempotencyKey,
              attachments: [
                {
                  type: "image",
                  mimeType: "image/png",
                  fileName: "dot.png",
                  content: CHAT_DOT_PNG_BASE64,
                },
              ],
            },
            respond: captureChatResponse(responses),
          });
          expect(responses[0]?.ok).toBe(true);
          const input = await captured.promise;
          expect(input.replyOptions?.images).toEqual(vision ? [INLINE_DOT_PNG_IMAGE] : undefined);
          expect(input.ctx.media).toEqual([
            expect.objectContaining({
              path: expect.any(String),
              contentType: "image/png",
              ...(vision
                ? { hydrationSuppressed: true }
                : { url: expect.stringMatching(/^media:\/\/inbound\//u), fileName: "dot.png" }),
            }),
          ]);
          const media = expectDefined(
            input.ctx.media?.[0],
            "accepted image must retain its media fact",
          );
          expect(media.workspaceDir).toBeUndefined();
          expect(media.staged).not.toBe(true);
          expect(
            await fs.readFile(
              expectDefined(media.path, "accepted image must retain its managed source"),
            ),
          ).toEqual(Buffer.from(CHAT_DOT_PNG_BASE64, "base64"));
          await harness.settle();
        } finally {
          dispatchInboundMessageMock.mockReset();
          testState.agentConfig = undefined;
        }
      });
    },
  );
}
