import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  patchSessionEntryCore,
  type SessionPendingInputReceipt,
  stageSessionPendingInput,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function request(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: `proof-${method}`, method, params },
    respond,
    client,
    isWebchatConnect: () => true,
    context,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "RPC response");
}

describe("registered chat read scope", () => {
  it.each([
    { name: "owner draft", actor: "owner", visibility: "draft", allowed: true },
    { name: "admin draft", actor: "admin", visibility: "draft", allowed: true },
    { name: "foreign draft view", actor: "view", visibility: "draft", allowed: false },
    { name: "foreign draft write", actor: "write", visibility: "draft", allowed: false },
    { name: "foreign draft none", actor: "none", visibility: "draft", allowed: false },
    { name: "foreign shared view", actor: "view", visibility: "shared", allowed: true },
    { name: "foreign shared none", actor: "none", visibility: "shared", allowed: false },
    {
      name: "foreign metadata-incognito",
      actor: "view",
      visibility: "shared",
      allowed: false,
      incognito: true,
    },
    {
      name: "foreign keyed-incognito",
      actor: "view",
      visibility: "shared",
      allowed: false,
      incognito: true,
      keyedIncognito: true,
    },
  ] as const)(
    "$name applies identical session visibility to history and full messages",
    async (testCase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = rolePolicyConfig();
        if (testCase.actor === "admin") {
          expectDefined(cfg.gateway?.roles?.definitions.write, "admin role definition").scopes = [
            "operator.admin",
          ];
        }
        await state.writeConfig(cfg);
        const owner = roleClient("write", "synthetic-owner");
        const client =
          testCase.actor === "owner"
            ? owner
            : roleClient(testCase.actor === "admin" ? "write" : testCase.actor, "synthetic-reader");
        if (testCase.actor === "admin") {
          client.connect.scopes = ["operator.admin"];
        }
        const scope = {
          agentId: "main",
          sessionKey:
            "keyedIncognito" in testCase
              ? "agent:main:dashboard:incognito-synthetic-draft"
              : "agent:main:synthetic-draft",
          sessionId: "synthetic-draft",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          visibility: testCase.visibility,
          ...("incognito" in testCase ? { incognito: testCase.incognito } : {}),
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile, "owner profile").profileId,
          },
        });
        await appendTranscriptMessage(scope, {
          eventId: "synthetic-transcript-id",
          message: { role: "user", content: "Synthetic private transcript" },
        });
        const receipt = expectDefined(
          await stageSessionPendingInput(scope, {
            runId: "synthetic-pending-run",
            assertCurrent: () => {},
            message: {
              role: "user",
              content: "Synthetic private pending input",
              timestamp: 1,
              idempotencyKey: "synthetic:user",
            },
          }),
          "pending receipt",
        );
        try {
          receipt.finish("cancelled");
          const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
          const history = await request(context, client, "chat.history", {
            sessionKey: scope.sessionKey,
          });
          expect(history[0]).toBe(testCase.allowed);
          for (const messageId of [
            "synthetic-transcript-id",
            `pending:${receipt.inputId}`,
            "missing-id",
          ]) {
            const result = await request(context, client, "chat.message.get", {
              sessionKey: scope.sessionKey,
              messageId,
            });
            expect.soft(result[0], messageId).toBe(testCase.allowed);
            if (testCase.allowed) {
              expect.soft(result[1]).toMatchObject({ ok: messageId !== "missing-id" });
            } else {
              expect.soft(result[1], messageId).toBeUndefined();
              expect.soft(result[2], messageId).toEqual(history[2]);
            }
          }
        } finally {
          receipt.finish("interrupted");
        }
      });
    },
  );

  it("traverses a full hidden page and keeps raw custody counts separate from execution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const client = roleClient("write", "pagination-owner");
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:paged-inputs",
        sessionId: "paged-inputs",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipts: SessionPendingInputReceipt[] = [];
      try {
        for (let index = 0; index < 23; index++) {
          receipts.push(
            expectDefined(
              await stageSessionPendingInput(scope, {
                runId: `synthetic-page-${index}`,
                assertCurrent: () => {},
                message: {
                  role: "user",
                  content: `Synthetic input ${index}`,
                  ...(index < 3 ? {} : { display: false }),
                  timestamp: index,
                  idempotencyKey: `synthetic-page-${index}:user`,
                },
              }),
              "page receipt",
            ),
          );
        }
        const queued = expectDefined(receipts[0], "queued receipt");
        const cancelled = expectDefined(receipts[1], "cancelled receipt");
        const interrupted = expectDefined(receipts[2], "interrupted receipt");
        cancelled.finish("cancelled");
        interrupted.finish("interrupted");
        const context = await createHistoryReadContext();
        const history = async (pendingBefore?: number) => {
          const [ok, payload, error] = await request(context, client, "chat.history", {
            sessionKey: scope.sessionKey,
            limit: 20,
            ...(pendingBefore === undefined ? {} : { pendingBefore }),
          });
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          return payload as {
            pendingInputs: {
              total: number;
              items: Array<{ id: string; state: string }>;
              nextBefore?: number;
            };
          };
        };
        const first = (await history()).pendingInputs;
        expect(first).toEqual({ total: 23, items: [], nextBefore: expect.any(Number) });
        const second = (await history(first.nextBefore)).pendingInputs;
        expect(second).toMatchObject({
          total: 23,
          items: [
            { id: queued.inputId, state: "queued" },
            { id: cancelled.inputId, state: "cancelled" },
            { id: interrupted.inputId, state: "interrupted" },
          ],
        });
        expect(second).not.toHaveProperty("nextBefore");
        expect(await loadTranscriptEvents(scope)).toEqual([]);
        for (const receipt of [cancelled, interrupted]) {
          expect(() =>
            receipt.run(() => appendTranscriptMessage(scope, { message: receipt.message })),
          ).toThrow("Pending input ownership ended");
        }
        await queued.run(() => appendTranscriptMessage(scope, { message: queued.message }));
        queued.finish("interrupted");
        expect((await history(first.nextBefore)).pendingInputs).toMatchObject({
          total: 22,
          items: [
            { id: cancelled.inputId, state: "cancelled" },
            { id: interrupted.inputId, state: "interrupted" },
          ],
        });
        await upsertSessionEntryCore(scope, {
          sessionId: "replacement-physical-session",
          updatedAt: 2,
        });
        expect((await history()).pendingInputs).toEqual({ items: [], total: 0 });
      } finally {
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
      }
    });
  });

  it.each(["draft", "replacement"] as const)(
    "rechecks %s after an asynchronous transcript read",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = rolePolicyConfig();
        await state.writeConfig(cfg);
        const owner = roleClient("write", "async-owner");
        const client = roleClient("view", "async-reader");
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:async-read",
          sessionId: "original-physical-session",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile, "owner").profileId,
          },
        });
        await appendTranscriptMessage(scope, {
          eventId: "async-message",
          message: { role: "user", content: "Synthetic old message" },
        });
        const read = transcriptReaders.readSessionMessageByIdAsync;
        const ready = createDeferredCore();
        const release = createDeferredCore();
        const spy = vi
          .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
          .mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            ready.resolve();
            await release.promise;
            return result;
          });
        const lookup = request(
          await createHistoryReadContext({ getRuntimeConfig: () => cfg }),
          client,
          "chat.message.get",
          { sessionKey: scope.sessionKey, messageId: "async-message" },
        );
        try {
          await ready.promise;
          await patchSessionEntryCore(scope, () =>
            change === "draft" ? { visibility: "draft" } : { sessionId: "replacement-session" },
          );
          release.resolve();
          const result = await lookup;
          expect(result[0]).toBe(false);
          expect(result[1]).toBeUndefined();
        } finally {
          release.resolve();
          spy.mockRestore();
          await lookup;
        }
      });
    },
  );
});
