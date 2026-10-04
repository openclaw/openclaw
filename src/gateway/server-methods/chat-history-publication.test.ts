import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as historyProjection from "../chat-display-projection.history.js";
import { handleChatHistoryRequest } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

const scope = {
  agentId: "main",
  sessionKey: "agent:main:history-publication",
  sessionId: "history-publication",
};
const message = { role: "assistant", content: "History fixture" };

async function prepareSession() {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(scope, { message });
  return createHistoryReadContext();
}

function expectPublication(respond: ReturnType<typeof vi.fn<RespondFn>>, allowed: boolean) {
  expect(respond).toHaveBeenCalledOnce();
  if (allowed) {
    expect(respond.mock.calls[0]?.[0]).toBe(true);
  } else {
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
  }
}

describe("history publication authority", () => {
  it("honors the retained read guard after startup and retained-transcript preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await prepareSession();
      const read = vi.spyOn(historyPages, "readChatHistoryPage");
      for (const method of ["chat.history", "chat.startup"] as const) {
        for (const retained of [false, true]) {
          for (const allowed of [false, true]) {
            let current = true;
            read.mockImplementationOnce(async (_params, _signal, retainAuthorization) => {
              retainAuthorization?.(() => current);
              return { messages: [message] };
            });
            context.readChatStartupProjection = async () => {
              if (!retained) {
                current = allowed;
              }
              return undefined;
            };
            const verify = vi.fn(async () => {
              current = allowed;
              return true;
            });
            const respond = vi.fn<RespondFn>();
            await handleChatHistoryRequest({
              params: { sessionKey: scope.sessionKey },
              client: null,
              context,
              respond,
              method,
              req: { type: "req", id: "publication", method },
              isWebchatConnect: () => false,
              ...(retained
                ? {
                    retainedTranscript: { sessionId: scope.sessionId, verifyRetainedState: verify },
                  }
                : {}),
            });
            expectPublication(respond, allowed);
            if (retained) {
              expect(verify).toHaveBeenCalledOnce();
            }
          }
        }
      }
    });
  });

  it("honors the message read guard after display preparation and permits unguarded canonical reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await prepareSession();
      const read = vi.spyOn(historyPages, "readChatHistoryMessageById");
      const prepareDisplay = vi.spyOn(
        historyProjection,
        "prepareForwardedMessageCronJobNameResolver",
      );
      for (const native of [false, true]) {
        for (const allowed of [false, true]) {
          let current = true;
          read.mockImplementationOnce(async (_params, retainAuthorization) => {
            if (native) {
              retainAuthorization?.(() => current);
            }
            return { found: true, oversized: false, message };
          });
          prepareDisplay.mockImplementationOnce(async () => {
            current = allowed;
            return () => undefined;
          });
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId: "fixture-message" },
            client: null,
            context,
            respond,
            req: { type: "req", id: "publication", method: "chat.message.get" },
            isWebchatConnect: () => false,
          });
          expectPublication(respond, !native || allowed);
        }
      }
    });
  });
});
