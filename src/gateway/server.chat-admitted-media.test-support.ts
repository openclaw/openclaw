import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  type SessionAccessScope,
} from "../config/sessions/session-accessor.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../media/media-reference.js";
import { getMediaDir } from "../media/store.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { callDirectChat } from "./server.chat-direct-handler.test-support.js";
import {
  captureChatResponse,
  type CapturedChatResponse,
} from "./server.chat-response.test-support.js";
import { writeStoredMainSession } from "./server.chat-session-store.test-support.js";

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
}
