import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptMessage,
  bindSessionPendingInputSources,
  listSessionPendingInputs,
  stageSessionPendingInput,
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { saveCronJobsStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as userProfileList from "../../state/user-profile-list.js";
import { setAvatar } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
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
import type { GatewayRequestContext, RespondFn } from "./types.js";

async function createScope(name: string, sessionId = name) {
  await captureRuntimeConfigAsyncReader()();
  const scope = { agentId: "main", sessionKey: `agent:main:${name}`, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return scope;
}

async function stageInput(
  scope: Parameters<typeof stageSessionPendingInput>[0],
  runId: string,
  message: Partial<Parameters<typeof stageSessionPendingInput>[1]["message"]> = {},
) {
  return expectDefined(
    await stageSessionPendingInput(scope, {
      runId,
      assertCurrent: () => {},
      message: {
        role: "user",
        content: runId,
        timestamp: 1,
        idempotencyKey: `${runId}:user`,
        ...message,
      },
    }),
    "pending input receipt",
  );
}

async function finishInputs(receipts: Awaited<ReturnType<typeof stageInput>>[]) {
  for (const receipt of receipts) {
    receipt.finish("interrupted");
    await receipt.settled?.();
  }
}

function request(
  method: "chat.history" | "chat.startup" | "chat.message.get",
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  respond: RespondFn,
) {
  const handler =
    method === "chat.message.get" ? chatMessageGetHandlers[method] : chatHistoryHandlers[method];
  return expectDefined(
    handler,
    "read handler",
  )({
    params,
    context,
    respond,
    req: { type: "req", id: "history", method },
    client: null,
    isWebchatConnect: () => false,
  });
}

async function readHistory(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  let result: unknown;
  await request(method, context, params, (ok, payload, error) => {
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    result = payload;
  });
  return expectDefined(asOptionalRecord(result), "history response");
}

describe("pending input read boundary", () => {
  it("prepares automation names once per pending page from the Gateway's selected partition", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = await createScope("pending-automation");
      const job: CronJob = {
        id: "report",
        name: "Wrong partition",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the queue." },
        state: {},
      };
      await saveCronJobsStore(state.statePath("cron", "jobs.json"), { version: 1, jobs: [job] });
      const cronStorePath = state.statePath("selected-cron", "jobs.json");
      const context = await createHistoryReadContext({ cronStorePath });
      const receipts = [];
      try {
        for (let index = 0; index < 20; index += 1) {
          receipts.push(
            await stageInput(scope, `automation-${index}`, {
              content: "The queue is clear.",
              provenance: {
                kind: "inter_session",
                sourceTool: "sessions_send",
                sourceSessionKey: "agent:main:cron:report:run:finished",
              },
            }),
          );
        }
        for (const name of ["Selected automation", "Renamed automation", undefined]) {
          await saveCronJobsStore(cronStorePath, {
            version: 1,
            jobs: name ? [{ ...job, name }] : [],
          });
          const counter = trackSqliteStatementExecutions(
            requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
            ["names", "selection"],
            (sql) =>
              /\bfrom\s+"?cron_jobs"?\b/iu.test(sql)
                ? "names"
                : sql.includes('"config_machine_state"')
                  ? "selection"
                  : null,
          );
          try {
            const expectedMessage = {
              role: "assistant",
              senderSession: expect.objectContaining({ label: name ?? "Automation" }),
            };
            const respond = vi.fn();
            await request("chat.history", context, { sessionKey: scope.sessionKey }, respond);
            expect(counter.counts).toEqual({ names: 0, selection: 0 });
            expect(respond).toHaveBeenLastCalledWith(
              true,
              expect.objectContaining({
                pendingInputs: expect.objectContaining({
                  total: 20,
                  items: Array.from({ length: 20 }, () =>
                    expect.objectContaining({ message: expect.objectContaining(expectedMessage) }),
                  ),
                }),
              }),
            );
            await request(
              "chat.message.get",
              context,
              {
                sessionKey: scope.sessionKey,
                messageId: `pending:${expectDefined(receipts[0], "first automation receipt").inputId}`,
              },
              respond,
            );
            expect(respond).toHaveBeenLastCalledWith(true, {
              ok: true,
              message: expect.objectContaining(expectedMessage),
            });
            expect(counter.counts).toEqual({ names: 0, selection: 0 });
          } finally {
            counter.restore();
          }
        }
      } finally {
        await finishInputs(receipts);
      }
    });
  });

  it("projects pending input acceptance times with fresh page-scoped sender displays", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("pending-display-time");
      const profile = ensureProfileForEmail("pending-sender@example.test");
      const receipts = [];
      const readDisplay = vi.spyOn(userProfileList, "getResidentUserProfileDisplay");
      try {
        for (let index = 0; index < 20; index += 1) {
          receipts.push(
            await stageInput(scope, `pending-display-run-${index}`, {
              content: `Pending input ${index}`,
              timestamp: 1_000 + index,
              __openclaw: {
                senderIdentity: { type: "profile", id: profile.id },
                senderName: "Historical sender",
              },
            }),
          );
        }
        // Acceptance belongs to the writer worker, independently of the display projection.
        const storedInputs = await listSessionPendingInputs(scope);
        const acceptanceTimes = new Map(
          storedInputs.items.map((input) => [input.id, input.acceptedAt]),
        );
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
          const page = await readHistory(context, { sessionKey: scope.sessionKey });
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
          receipts.map((receipt, index) => {
            const acceptedAt = expectDefined(
              acceptanceTimes.get(receipt.inputId),
              "stored acceptance time",
            );
            expect(acceptedAt).not.toBe(1_000 + index);
            return expect.objectContaining({
              id: receipt.inputId,
              acceptedAt,
              message: expect.objectContaining({
                content: `Pending input ${index}`,
                timestamp: acceptedAt,
                __openclaw: expect.objectContaining({
                  senderIdentity: { type: "profile", id: profile.id },
                  senderName: "Historical sender",
                  senderProfileAvatarUrl: expect.stringContaining(profile.id),
                }),
              }),
            });
          }),
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
        await finishInputs(receipts);
      }
    });
  });

  it("keeps cancelled input readable and sanitized without changing the transcript or crossing a reset", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("accepted", "accepted-session");
      const receipt = await stageInput(scope, "r".repeat(300), {
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
      });
      try {
        receipt.finish("cancelled");
        await receipt.settled?.();
        const page = await readChatPendingInputs(scope, { limit: 1, maxChars: 50 });
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
        const context = await createHistoryReadContext();
        const lookup = () =>
          request(
            "chat.message.get",
            context,
            { sessionKey: scope.sessionKey, messageId: displayId },
            respond,
          );
        const sql = observeHostDataSql();
        try {
          await lookup();
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
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
        await finishInputs([receipt]);
      }
    });
  });

  it("does not reveal an input hidden by the canonical history visibility policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("hidden-input", "hidden-session");
      const receipt = await stageInput(scope, "hidden-run", {
        display: false,
        content: "Internal continuation",
        timestamp: 1,
        idempotencyKey: "hidden:user",
      });
      try {
        expect((await readChatPendingInputs(scope, { limit: 20, maxChars: 100 })).items).toEqual(
          [],
        );
        const respond = vi.fn();
        await request(
          "chat.message.get",
          await createHistoryReadContext(),
          { sessionKey: scope.sessionKey, messageId: `pending:${receipt.inputId}` },
          respond,
        );
        expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: "not_visible" });
      } finally {
        await finishInputs([receipt]);
      }
    });
  });
});

describe("pending input consumption receipts", () => {
  it.each(["chat.history", "chat.startup"] as const)(
    "%s returns only requested current-session receipts in pages and empty deltas",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const scope = await createScope("collected");
        const context = await createHistoryReadContext();
        const call = (params: Record<string, unknown> = {}) =>
          readHistory(context, { sessionKey: scope.sessionKey, ...params }, method);
        const sources = [];
        for (const runId of ["source-a", "source-b"]) {
          sources.push(await stageInput(scope, runId));
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
            retained.push(await stageInput(scope, `retained-${index}`, { timestamp: index + 3 }));
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
          retained[0]?.finish("cancelled");
          await retained[0]?.settled?.();
          const cancelledPage = await call({ inputRunIds: ["retained-0"], limit: 1 });
          expect(cancelledPage.pendingInputs).toMatchObject({ queuedCount: 0 });
          expect(cancelledPage.inputReceipts).toEqual([
            { runId: "retained-0", state: "pending", cancelled: true },
          ]);
          const anchor = await call({
            inputRunIds,
            messageId: aggregate.inputId,
            sessionId: scope.sessionId,
          });
          expect(anchor.inputReceipts).toEqual([]);
          await upsertSessionEntryCore(scope, { sessionId: "replacement", updatedAt: 2 });
          expect((await call({ inputRunIds })).inputReceipts).toEqual([]);
        } finally {
          await finishInputs([aggregate, ...sources, ...retained]);
        }
      });
    },
  );
});
