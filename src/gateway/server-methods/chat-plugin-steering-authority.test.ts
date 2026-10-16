import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptMessage,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import * as historyPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

it("withholds plugin guidance when Control UI session access is revoked after history preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:steering-history-revocation",
      sessionId: "steering-history-revocation",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    await appendTranscriptMessage(scope, {
      eventId: "plugin-note",
      message: {
        role: "user",
        display: false,
        content: "Private model prefix\n\nKeep the change small.",
        provenance: { kind: "internal_system", sourceTool: "plugin:reviewer" },
        __openclaw: {
          pluginSteering: {
            pluginId: "reviewer",
            pluginName: "Reviewer",
            displayText: "Keep the change small.",
          },
        },
      },
    });
    const client = identifiedClient("viewer");
    const context = await createHistoryReadContext();
    const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
    const call = async (respond: RespondFn) =>
      handler({
        params: { sessionKey: scope.sessionKey },
        client,
        context,
        respond,
        req: { type: "req", id: "steering-history-revocation", method: "chat.history" },
        isWebchatConnect: () => true,
      });
    const initial = vi.fn<RespondFn>();
    await call(initial);
    expect(initial).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            display: true,
            content: [{ type: "text", text: "Keep the change small." }],
          }),
        ],
      }),
    );

    const prepared = createDeferred();
    const release = createDeferred();
    const read = historyPages.readChatHistoryPage;
    const readSpy = vi
      .spyOn(historyPages, "readChatHistoryPage")
      .mockImplementationOnce(async (...args) => {
        const page = await read(...args);
        prepared.resolve();
        await release.promise;
        return page;
      });
    const respond = vi.fn<RespondFn>();
    const pending = call(respond);
    try {
      await Promise.race([prepared.promise, pending]);
      expect(readSpy).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
    } finally {
      release.resolve();
      try {
        await pending;
      } finally {
        readSpy.mockRestore();
      }
    }
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("Keep the change small.");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("Private model prefix");
  });
});
