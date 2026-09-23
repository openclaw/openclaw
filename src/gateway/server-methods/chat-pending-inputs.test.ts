import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  stageSessionPendingInput,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { ensureProfileForEmail, setAvatar } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { readChatPendingInputs } from "./chat-pending-inputs.js";
import type { GatewayRequestContext } from "./types.js";

describe("pending input read boundary", () => {
  it("projects pending input acceptance times with fresh page-scoped sender displays", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
      const profile = ensureProfileForEmail("pending-sender@example.test");
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:pending-display-time",
        sessionId: "pending-display-time",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipts = [];
      const readDisplay = vi.spyOn(userProfileList, "getUserProfileDisplay");
      try {
        for (let index = 0; index < 20; index += 1) {
          now.mockReturnValue(2_000 + index);
          receipts.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId: `pending-display-run-${index}`,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: `Pending input ${index}`,
                  timestamp: 1_000 + index,
                  idempotencyKey: `pending-display-run-${index}:user`,
                  __openclaw: {
                    senderIdentity: { type: "profile", id: profile.id },
                    senderName: "Historical sender",
                  },
                },
              }),
              "pending input receipt",
            ),
          );
        }
        const context = await createHistoryReadContext();
        const readPage = async () => {
          readDisplay.mockClear();
          let result: unknown;
          await expectDefined(
            chatHistoryHandlers["chat.history"],
            "history handler",
          )({
            params: { sessionKey: scope.sessionKey },
            context,
            req: { type: "req", id: "history", method: "chat.history" },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          const page = expectDefined(asOptionalRecord(result), "history response");
          const pending = expectDefined(asOptionalRecord(page.pendingInputs), "pending inputs");
          expect(pending.total).toBe(20);
          expect(readDisplay.mock.calls.filter(([id]) => id === profile.id)).toHaveLength(1);
          return pending.items as Array<Record<string, unknown>>;
        };
        const initial = await readPage();
        expect(initial).toEqual(
          receipts.map((receipt, index) =>
            expect.objectContaining({
              id: receipt.inputId,
              acceptedAt: 2_000 + index,
              message: expect.objectContaining({
                content: `Pending input ${index}`,
                timestamp: 2_000 + index,
                __openclaw: expect.objectContaining({
                  senderIdentity: { type: "profile", id: profile.id },
                  senderName: "Historical sender",
                  senderProfileAvatarUrl: expect.stringContaining(profile.id),
                }),
              }),
            }),
          ),
        );
        const initialBytes = JSON.stringify(initial);
        expect(initialBytes).not.toContain("idempotencyKey");
        expect(setAvatar(profile.id, Buffer.from("updated avatar"), "image/png").ok).toBe(true);
        const updated = await readPage();
        const initialMessage = asOptionalRecord(initial[0]?.message);
        const updatedMessage = asOptionalRecord(updated[0]?.message);
        const initialAvatar = asOptionalRecord(
          initialMessage?.["__openclaw"],
        )?.senderProfileAvatarUrl;
        const updatedAvatar = asOptionalRecord(
          updatedMessage?.["__openclaw"],
        )?.senderProfileAvatarUrl;
        expect(updatedAvatar).not.toBe(initialAvatar);
        expect(updated).toEqual(
          initial.map((item) => {
            const message = expectDefined(asOptionalRecord(item.message), "pending message");
            return {
              ...item,
              message: {
                ...message,
                __openclaw: {
                  ...asOptionalRecord(message["__openclaw"]),
                  senderProfileAvatarUrl: updatedAvatar,
                },
              },
            };
          }),
        );
        expect(JSON.stringify(initial)).toBe(initialBytes);
      } finally {
        readDisplay.mockRestore();
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
        now.mockRestore();
      }
    });
  });

  it("keeps cancelled input readable and sanitized without changing the transcript or crossing a reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:accepted",
        sessionId: "accepted-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "r".repeat(300),
          assertCurrent: () => {},
          message: {
            role: "user",
            content: "Accepted input ".repeat(2000),
            timestamp: 1,
            idempotencyKey: "queued:user",
            __openclaw: {
              media: [
                {
                  kind: "image",
                  data: "synthetic-inline-payload",
                  url: "https://example.test/image?credential=synthetic",
                },
              ],
            },
          },
        }),
        "pending receipt",
      );
      try {
        receipt.finish("cancelled");
        const page = readChatPendingInputs(scope, { limit: 1, maxChars: 50 });
        const displayId = `pending:${receipt.inputId}`;
        expect(page).toMatchObject({
          total: 1,
          items: [
            { state: "cancelled", message: { __openclaw: { id: displayId, truncated: true } } },
          ],
        });
        expect(page.items[0]).not.toHaveProperty("runId");
        expect(JSON.stringify(page)).not.toContain("synthetic-inline-payload");
        expect(JSON.stringify(page)).not.toContain("credential=");
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        const respond = vi.fn();
        const lookup = () =>
          expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId: displayId },
            respond,
            context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
            req: {} as never,
            client: null,
            isWebchatConnect: () => false,
          });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            message: expect.objectContaining({ content: receipt.message.content }),
          }),
        );
        await upsertSessionEntryCore(scope, { sessionId: "replacement-session", updatedAt: 2 });
        await lookup();
        expect(respond).toHaveBeenLastCalledWith(true, {
          ok: false,
          unavailableReason: "not_found",
        });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });

  it("does not reveal an input hidden by the canonical history visibility policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:hidden-input",
        sessionId: "hidden-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId: "hidden-run",
          assertCurrent: () => {},
          message: {
            role: "user",
            display: false,
            content: "Internal continuation",
            timestamp: 1,
            idempotencyKey: "hidden:user",
          },
        }),
        "hidden pending receipt",
      );
      try {
        expect(readChatPendingInputs(scope, { limit: 20, maxChars: 100 }).items).toEqual([]);
        const respond = vi.fn();
        await expectDefined(
          chatMessageGetHandlers["chat.message.get"],
          "message handler",
        )({
          params: { sessionKey: scope.sessionKey, messageId: `pending:${receipt.inputId}` },
          respond,
          context: { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext,
          req: {} as never,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_visible" });
      } finally {
        receipt.finish("interrupted");
      }
    });
  });
});
