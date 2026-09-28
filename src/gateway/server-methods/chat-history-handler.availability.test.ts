import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import * as chatHistoryPages from "./chat-history-pages.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

describe("chat history worker availability", () => {
  it.each([
    { code: "overloaded", message: "session history is busy; retry shortly" },
    { code: "unavailable", message: "session history is temporarily unavailable; retry shortly" },
    { code: "timeout", message: "session history read timed out; retry shortly" },
  ] as const)(
    "returns retryable history errors when a worker is $code",
    async ({ code, message }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = await createHistoryReadContext();
        const readSpy = vi
          .spyOn(chatHistoryPages, "readChatHistoryPage")
          .mockRejectedValue(new WorkerTaskError("internal worker failure detail", code));
        try {
          for (const method of ["chat.history", "chat.startup"] as const) {
            const respond = vi.fn<RespondFn>();
            await expectDefined(
              chatHistoryHandlers[method],
              "history handler",
            )({
              params: { sessionKey: "agent:main:worker-availability" },
              client: null,
              context,
              respond,
              req: { type: "req", id: "worker-availability", method },
              isWebchatConnect: () => false,
            });
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              false,
              undefined,
              expect.objectContaining({
                code: "UNAVAILABLE",
                message,
                retryable: true,
                retryAfterMs: 250,
                details: { method },
              }),
            );
          }
        } finally {
          readSpy.mockRestore();
        }
      });
    },
  );

  it("preserves unexpected history worker failures for the request error owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await createHistoryReadContext();
      const failure = new WorkerTaskError("unexpected worker task failure", "failed");
      const readSpy = vi
        .spyOn(chatHistoryPages, "readChatHistoryPage")
        .mockRejectedValueOnce(failure);
      const respond = vi.fn<RespondFn>();
      try {
        await expect(
          expectDefined(
            chatHistoryHandlers["chat.history"],
            "history handler",
          )({
            params: { sessionKey: "agent:main:worker-availability" },
            client: null,
            context,
            respond,
            req: { type: "req", id: "worker-availability", method: "chat.history" },
            isWebchatConnect: () => false,
          }),
        ).rejects.toBe(failure);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        readSpy.mockRestore();
      }
    });
  });
});
