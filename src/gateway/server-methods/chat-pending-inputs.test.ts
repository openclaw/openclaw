import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  bindSessionPendingInputSources,
  stageSessionPendingInput,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { ensureProfileForEmail, setAvatar } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  abortQueuedChatTurnById,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
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
        for (const [index, overrides] of [
          {},
          { sessionId: "another-session" },
          { agentId: "another-agent" },
          {},
          {},
          {},
        ].entries()) {
          const controller = new AbortController();
          const runId = index === 5 ? "external-run-".repeat(30) : `pending-display-run-${index}`;
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: context.chatQueuedTurns,
              ...scope,
              ...overrides,
              runId,
              controller,
            }),
          ).toBe(true);
          if (index === 3) {
            retireQueuedChatTurnCancellation(context.chatQueuedTurns, runId, controller);
          } else if (index === 4) {
            controller.abort();
          }
        }
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
          expect(pending.queuedCount).toBe(1);
          expect(readDisplay.mock.calls.filter(([id]) => id === profile.id)).toHaveLength(1);
          return pending.items as Array<Record<string, unknown>>;
        };
        const initial = await readPage();
        expect(initial.filter((item) => item.queued).map((item) => item.runId)).toEqual([
          "pending-display-run-0",
        ]);
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

describe("pending input consumption receipts", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns only requested current-session receipts in pages and empty deltas",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:collected",
          sessionId: "collected",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const context = await createHistoryReadContext();
        const handler = expectDefined(chatHistoryHandlers[method], "history handler");
        const call = async (params: Record<string, unknown> = {}) => {
          let result: unknown;
          await handler({
            params: { sessionKey: scope.sessionKey, ...params },
            context,
            req: { type: "req", id: "history", method },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              result = payload;
            },
          });
          return expectDefined(asOptionalRecord(result), "history response");
        };
        const sources = [];
        for (const runId of ["source-a", "source-b"]) {
          sources.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: runId,
                  timestamp: 1,
                  idempotencyKey: `${runId}:user`,
                },
              }),
              "source receipt",
            ),
          );
        }
        const aggregate = expectDefined(
          bindSessionPendingInputSources(sources, {
            role: "user",
            content: "Collected inputs",
            timestamp: 2,
            idempotencyKey: "collect:batch",
          }),
          "aggregate receipt",
        );
        const retained = [];
        try {
          await aggregate.run(() => appendTranscriptMessage(scope, { message: aggregate.message }));
          await appendTranscriptMessage(scope, {
            message: { role: "assistant", content: "Later reply" },
          });
          const inputRunIds = ["source-a", "missing"];
          const page = await call({ inputRunIds, limit: 1 });
          const expected = [
            { runId: "source-a", state: "consumed", consumedByEventId: aggregate.inputId },
          ];
          expect(page.inputReceipts).toEqual(expected);
          expect(page.inputConsumptions).toEqual([
            { runId: "source-a", consumedByEventId: aggregate.inputId },
          ]);
          expect(page.pendingInputs).toEqual({ items: [], total: 0, queuedCount: 0 });
          expect(JSON.stringify(page.messages)).not.toContain("Collected inputs");
          const delta = await call({ inputRunIds, cursor: page.deltaCursor });
          expect(delta).toMatchObject({ kind: "delta", messages: [], inputReceipts: expected });
          for (let index = 0; index < 21; index += 1) {
            retained.push(
              expectDefined(
                await stageSessionPendingInput(scope, {
                  runId: `retained-${index}`,
                  assertCurrent: () => {},
                  message: {
                    role: "user",
                    content: `retained-${index}`,
                    timestamp: index + 3,
                    idempotencyKey: `retained-${index}:user`,
                  },
                }),
                "retained receipt",
              ),
            );
          }
          expect(
            registerQueuedChatTurn({
              chatQueuedTurns: context.chatQueuedTurns,
              ...scope,
              runId: "retained-0",
              controller: new AbortController(),
            }),
          ).toBe(true);
          const retainedPage = await call({ inputRunIds: ["retained-0", "retained-1"], limit: 1 });
          expect(retainedPage.inputReceipts).toEqual([
            { runId: "retained-0", state: "pending", queued: true },
            { runId: "retained-1", state: "pending" },
          ]);
          expect(retainedPage.inputConsumptions).toEqual([]);
          expect(retainedPage.pendingInputs).toMatchObject({
            total: 21,
            queuedCount: 1,
            items: [{ runId: "retained-20" }],
          });
          expect(
            abortQueuedChatTurnById(context.chatQueuedTurns, {
              runId: "retained-0",
              sessionKey: scope.sessionKey,
            }).aborted,
          ).toBe(true);
          const cancelledPage = await call({ inputRunIds: ["retained-0"], limit: 1 });
          expect(cancelledPage.pendingInputs).toMatchObject({ queuedCount: 0 });
          expect(cancelledPage.inputReceipts).toEqual([{ runId: "retained-0", state: "pending" }]);
          const anchor = await call({
            inputRunIds,
            messageId: aggregate.inputId,
            sessionId: scope.sessionId,
          });
          expect(anchor.inputReceipts).toEqual([]);
          await upsertSessionEntryCore(scope, { sessionId: "replacement", updatedAt: 2 });
          expect((await call({ inputRunIds })).inputReceipts).toEqual([]);
        } finally {
          aggregate.finish("interrupted");
          for (const source of sources) {
            source.finish("interrupted");
          }
          for (const receipt of retained) {
            receipt.finish("interrupted");
          }
        }
      });
    },
  );
});
