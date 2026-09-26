import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

describe("retained transcript sharing", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s requires current sharing authority for a retained transcript",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { defaults: { model: "openai/gpt-5.6-sol" } },
          plugins: { enabled: false },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:retained-private-history",
          sessionId: "retained-private-history",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          displayName: "Private retained conversation",
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        const { messageId } = await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Private retained message", timestamp: 1 },
        });
        const client = identifiedClient("viewer");
        const readChatStartupProjection = vi.fn(async () => undefined);
        const context = await createHistoryReadContext({
          getRuntimeConfig: () => cfg,
          readChatStartupProjection,
        });
        const call = async () => {
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            chatHistoryHandlers[method],
            "history handler",
          )({
            params: { ...scope, messageId },
            client,
            context,
            respond,
            req: { type: "req", id: "retained-private-history", method },
            isWebchatConnect: () => false,
          });
          return respond;
        };
        const expectHidden = (respond: ReturnType<typeof vi.fn<RespondFn>>) => {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        };
        expectHidden(await call());
        readChatStartupProjection.mockClear();
        expect(
          await deleteSessionEntryLifecycle({
            agentId: scope.agentId,
            storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
            target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
            archiveTranscript: false,
          }),
        ).toMatchObject({ deleted: true });
        expectHidden(await call());
        expect(readChatStartupProjection).not.toHaveBeenCalled();
        client.connect.scopes = ["operator.admin"];
        expect(await call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            messages: [expect.objectContaining({ content: "Private retained message" })],
          }),
        );
        readChatStartupProjection.mockImplementationOnce(async () => {
          client.connect.scopes = ["operator.read"];
          return undefined;
        });
        expectHidden(await call());
      });
    },
  );
});
