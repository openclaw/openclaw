import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  patchSessionEntryCore,
  stageSessionPendingInput,
  upsertSessionEntryCore,
  type SessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc as request } from "./chat-rpc-fixture.test-support.js";

type Actor = "owner" | "admin" | "view" | "write" | "none";
type Scope = Parameters<typeof upsertSessionEntryCore>[0] & { sessionId: string };
async function withReadFixture(
  run: (f: {
    scope: Scope;
    createdActor: NonNullable<SessionEntry["createdActor"]>;
    call: (method: string, params?: Record<string, unknown>) => ReturnType<typeof request>;
  }) => Promise<void>,
  actor: Actor = "owner",
  keyedIncognito = false,
  policy = true,
) {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = policy ? rolePolicyConfig() : await captureRuntimeConfigAsyncReader()();
      const owner = roleClient("write", "read-owner");
      const client =
        actor === "owner" ? owner : roleClient(actor === "admin" ? "write" : actor, "reader");
      if (actor === "admin") {
        expectDefined(cfg.gateway?.roles?.definitions.write, "admin role").scopes =
          client.connect.scopes = ["operator.admin"];
      }
      if (policy) {
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
      }
      ensureUserProfilesSchema({});
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const scope = {
        agentId: "main",
        sessionKey: keyedIncognito ? "agent:main:dashboard:incognito-read" : "agent:main:read",
        sessionId: "read-session",
      };
      let context: ReturnType<typeof createHistoryReadContext> | undefined;
      const call = async (method: string, params: Record<string, unknown> = {}) =>
        request(
          await (context ??= createHistoryReadContext(
            policy ? { getRuntimeConfig: () => cfg } : undefined,
          )),
          client,
          method,
          { sessionKey: scope.sessionKey, ...params },
        );
      await run({
        scope,
        call,
        createdActor: {
          type: "human",
          source: "profile",
          id: expectDefined(owner.authenticatedUserProfile, "owner").profileId,
        },
      });
    },
  );
}

const seed = (scope: Scope, entry: Partial<SessionEntry> = {}) =>
  upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1, ...entry });
async function pending(scope: Scope, index = 0, hidden = false) {
  return expectDefined(
    await stageSessionPendingInput(scope, {
      runId: `pending-${index}`,
      assertCurrent: () => {},
      message: {
        role: "user",
        content: `Synthetic input ${index}`,
        timestamp: index,
        idempotencyKey: `pending-${index}:user`,
        ...(hidden ? { display: false } : {}),
      },
    }),
    "pending receipt",
  );
}

it.each([
  ["owner", "draft", true, false, false],
  ["admin", "draft", true, false, false],
  ["view", "draft", false, false, false],
  ["write", "draft", false, false, false],
  ["none", "draft", false, false, false],
  ["view", "shared", true, false, false],
  ["none", "shared", false, false, false],
  ["view", "shared", false, true, false],
  ["view", "shared", false, true, true],
] as const)(
  "%s/%s history and message visibility (allowed=%s, incognito=%s, keyed=%s)",
  (actor, visibility, allowed, incognito, keyed) =>
    withReadFixture(
      async ({ call, scope, createdActor }) => {
        await seed(scope, { visibility, createdActor, ...(incognito ? { incognito } : {}) });
        await appendTranscriptMessage(scope, {
          eventId: "message",
          message: { role: "user", content: "Private transcript" },
        });
        const receipt = await pending(scope);
        try {
          receipt.finish("cancelled");
          const history = await call("chat.history");
          expect(history[0]).toBe(allowed);
          for (const messageId of ["message", `pending:${receipt.inputId}`, "missing-id"]) {
            const result = await call("chat.message.get", { messageId });
            expect.soft(result[0], messageId).toBe(allowed);
            if (allowed) {
              expect.soft(result[1]).toMatchObject({ ok: messageId !== "missing-id" });
            } else {
              expect.soft(result.slice(1, 3), messageId).toEqual([undefined, history[2]]);
            }
          }
        } finally {
          receipt.finish("interrupted");
        }
      },
      actor,
      keyed,
    ),
);

it("traverses a full hidden page and keeps raw custody counts separate from execution", () =>
  withReadFixture(
    async ({ call, scope }) => {
      await seed(scope);
      const receipts: SessionPendingInputReceipt[] = [];
      try {
        for (let index = 0; index < 23; index++) {
          receipts.push(await pending(scope, index, index >= 3));
        }
        const queued = expectDefined(receipts[0], "queued");
        const cancelled = expectDefined(receipts[1], "cancelled");
        const interrupted = expectDefined(receipts[2], "interrupted");
        cancelled.finish("cancelled");
        interrupted.finish("interrupted");
        const history = async (pendingBefore?: number) => {
          const [ok, payload, error] = await call("chat.history", {
            limit: 20,
            ...(pendingBefore === undefined ? {} : { pendingBefore }),
          });
          expect([ok, error]).toEqual([true, undefined]);
          return (payload as { pendingInputs: ChatPendingInputsPage }).pendingInputs;
        };
        const first = await history();
        expect(first).toEqual({
          total: 23,
          items: [],
          queuedCount: 0,
          nextBefore: expect.any(Number),
        });
        const retainedItems = [
          { id: cancelled.inputId, state: "cancelled" },
          { id: interrupted.inputId, state: "interrupted" },
        ];
        const second = await history(first.nextBefore);
        expect(second).toMatchObject({
          total: 23,
          items: [{ id: queued.inputId, state: "queued" }, ...retainedItems],
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
        expect(await history(first.nextBefore)).toMatchObject({ total: 22, items: retainedItems });
        await seed(scope, { sessionId: "replacement-physical-session", updatedAt: 2 });
        expect(await history()).toEqual({ items: [], total: 0, queuedCount: 0 });
      } finally {
        for (const receipt of receipts) {
          receipt.finish("interrupted");
        }
      }
    },
    "owner",
    false,
    false,
  ));

it.each(["draft", "replacement"] as const)(
  "rechecks %s after an asynchronous transcript read",
  (change) =>
    withReadFixture(async ({ call, scope, createdActor }) => {
      await seed(scope, { visibility: "shared", createdActor });
      await appendTranscriptMessage(scope, {
        eventId: "message",
        message: { role: "user", content: "Synthetic old message" },
      });
      const read = transcriptReaders.readSessionMessageByIdAsync;
      const ready = createDeferredCore();
      const release = createDeferredCore();
      using _ = vi
        .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
        .mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          ready.resolve();
          await release.promise;
          return result;
        });
      const lookup = call("chat.message.get", { messageId: "message" });
      try {
        await ready.promise;
        await patchSessionEntryCore(scope, () =>
          change === "draft" ? { visibility: "draft" } : { sessionId: "replacement-session" },
        );
        release.resolve();
        const result = await lookup;
        expect(result.slice(0, 2)).toEqual([false, undefined]);
      } finally {
        release.resolve();
        await lookup;
      }
    }, "view"),
);
