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
  type SessionPendingInputReceipt,
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
import type { GatewayRequestContext } from "./types.js";

async function createScope(name: string, sessionId = name) {
  await captureRuntimeConfigAsyncReader()();
  const scope = { agentId: "main", sessionKey: `agent:main:${name}`, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return scope;
}

function pendingInputs(scope: Parameters<typeof stageSessionPendingInput>[0]) {
  const receipts: SessionPendingInputReceipt[] = [];
  return {
    receipts,
    async stage(
      runId: string,
      message: Partial<Parameters<typeof stageSessionPendingInput>[1]["message"]> = {},
    ) {
      const idempotencyKey = `${runId}:user`;
      const receipt = expectDefined(
        await stageSessionPendingInput(scope, {
          runId,
          assertCurrent: () => {},
          message: { role: "user", content: runId, timestamp: 1, idempotencyKey, ...message },
        }),
        "pending input receipt",
      );
      receipts.push(receipt);
      return receipt;
    },
    async [Symbol.asyncDispose]() {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
    },
  };
}

async function read(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  method: "chat.history" | "chat.startup" | "chat.message.get" = "chat.history",
) {
  const handler =
    method === "chat.message.get" ? chatMessageGetHandlers[method] : chatHistoryHandlers[method];
  let result: unknown;
  const handle = expectDefined(handler, "read handler");
  await handle({
    params,
    context,
    respond: (ok, payload, error) => {
      expect([ok, error]).toEqual([true, undefined]);
      result = payload;
    },
    req: { type: "req", id: "history", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return expectDefined(asOptionalRecord(result), "read response");
}

describe("pending input read boundary", () => {
  it("prepares automation names once per pending page from the Gateway's selected partition", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
      await using inputs = pendingInputs(scope);
      const { receipts } = inputs;
      for (let index = 0; index < 20; index += 1) {
        await inputs.stage(`automation-${index}`, {
          content: "The queue is clear.",
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:cron:report:run:finished",
          },
        });
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
          const page = await read(context, { sessionKey: scope.sessionKey });
          expect(counter.counts).toEqual({ names: 0, selection: 0 });
          expect(page.pendingInputs).toMatchObject({
            total: 20,
            items: Array.from({ length: 20 }, () => ({ message: expectedMessage })),
          });
          const message = await read(
            context,
            {
              sessionKey: scope.sessionKey,
              messageId: `pending:${expectDefined(receipts[0], "first automation receipt").inputId}`,
            },
            "chat.message.get",
          );
          expect(message).toEqual({ ok: true, message: expect.objectContaining(expectedMessage) });
          expect(counter.counts).toEqual({ names: 0, selection: 0 });
        } finally {
          counter.restore();
        }
      }
    }));

  it("projects pending input acceptance times with fresh page-scoped sender displays", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("pending-display-time");
      const profile = ensureProfileForEmail("pending-sender@example.test");
      await using inputs = pendingInputs(scope);
      const { receipts } = inputs;
      const readDisplay = vi.spyOn(userProfileList, "getResidentUserProfileDisplay");
      try {
        for (let index = 0; index < 20; index += 1) {
          await inputs.stage(`pending-display-run-${index}`, {
            content: `Pending input ${index}`,
            timestamp: 1_000 + index,
            __openclaw: {
              senderIdentity: { type: "profile", id: profile.id },
              senderName: "Historical sender",
            },
          });
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
          const page = await read(context, { sessionKey: scope.sessionKey });
          const pending = expectDefined(asOptionalRecord(page.pendingInputs), "pending inputs");
          expect(pending).toMatchObject({ total: 20, queuedCount: 1 });
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
        const avatar = (items: typeof initial) =>
          asOptionalRecord(asOptionalRecord(items[0]?.message)?.["__openclaw"])
            ?.senderProfileAvatarUrl;
        const updatedAvatar = avatar(updated);
        expect(updatedAvatar).not.toBe(avatar(initial));
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
      }
    }));

  it("keeps cancelled input readable and sanitized without changing the transcript or crossing a reset", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("accepted", "accepted-session");
      await using inputs = pendingInputs(scope);
      const receipt = await inputs.stage("r".repeat(300), {
        content: "Accepted input ".repeat(2000),
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
      expect(JSON.stringify(page)).not.toMatch(/synthetic-inline-payload|credential=/);
      expect(await loadTranscriptEvents(scope)).toEqual([]);
      const context = await createHistoryReadContext();
      const lookup = () =>
        read(context, { sessionKey: scope.sessionKey, messageId: displayId }, "chat.message.get");
      const sql = observeHostDataSql();
      let message: Awaited<ReturnType<typeof read>>;
      try {
        message = await lookup();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(message).toMatchObject({ ok: true, message: { content: receipt.message.content } });
      await upsertSessionEntryCore(scope, { sessionId: "replacement-session", updatedAt: 2 });
      expect(await lookup()).toEqual({ ok: false, unavailableReason: "not_found" });
    }));

  it("does not reveal an input hidden by the canonical history visibility policy", () =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("hidden-input", "hidden-session");
      await using inputs = pendingInputs(scope);
      const receipt = await inputs.stage("hidden-run", {
        display: false,
        content: "Internal continuation",
        idempotencyKey: "hidden:user",
      });
      expect((await readChatPendingInputs(scope, { limit: 20, maxChars: 100 })).items).toEqual([]);
      const message = await read(
        await createHistoryReadContext(),
        {
          sessionKey: scope.sessionKey,
          messageId: `pending:${receipt.inputId}`,
        },
        "chat.message.get",
      );
      expect(message).toEqual({ ok: false, unavailableReason: "not_visible" });
    }));
});

it.each(["chat.history", "chat.startup"] as const)(
  "%s returns only requested current-session receipts in pages and empty deltas",
  (method) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = await createScope("collected");
      const context = await createHistoryReadContext();
      const call = (params: Record<string, unknown> = {}) =>
        read(context, { sessionKey: scope.sessionKey, ...params }, method);
      await using inputs = pendingInputs(scope);
      const sources = [];
      for (const runId of ["source-a", "source-b"]) {
        sources.push(await inputs.stage(runId));
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
      inputs.receipts.unshift(aggregate);
      await aggregate.run(() => appendTranscriptMessage(scope, { message: aggregate.message }));
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: "Later reply" },
      });
      const inputRunIds = ["source-a", "missing"];
      const page = await call({ inputRunIds, limit: 1 });
      const expected = [
        { runId: "source-a", state: "consumed", consumedByEventId: aggregate.inputId },
      ];
      expect([page.inputReceipts, page.inputConsumptions, page.pendingInputs]).toEqual([
        expected,
        [{ runId: "source-a", consumedByEventId: aggregate.inputId }],
        { items: [], total: 0, queuedCount: 0 },
      ]);
      expect(JSON.stringify(page.messages)).not.toContain("Collected inputs");
      const delta = await call({ inputRunIds, cursor: page.deltaCursor });
      expect(delta).toMatchObject({ kind: "delta", messages: [], inputReceipts: expected });
      for (let index = 0; index < 21; index += 1) {
        retained.push(await inputs.stage(`retained-${index}`, { timestamp: index + 3 }));
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
      expect([retainedPage.inputReceipts, retainedPage.inputConsumptions]).toEqual([
        [
          { runId: "retained-0", state: "pending", queued: true },
          { runId: "retained-1", state: "pending" },
        ],
        [],
      ]);
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
    }),
);
