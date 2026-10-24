import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as questionStorage from "../../config/sessions/session-questions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as registration from "./question.durable-registration.js";
import {
  broadcast,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

type Fixture = {
  runtime: GatewayClient;
  entry: SessionEntry;
  call: (
    method: string,
    params: Record<string, unknown>,
    client?: GatewayClient,
  ) => Promise<unknown[]>;
  close: () => Promise<void>;
};

export function registerQuestionCollisionTests(
  createFixture: (
    durable?: boolean,
    legacyGeneration?: boolean,
    creatorProfileId?: string,
  ) => Promise<Fixture>,
) {
  installQuestionTestHooks();
  describe("durable registration global ID ownership", () => {
    it.each(["same-agent", "other-agent"])(
      "rejects an existing %s transient ID before worker registration",
      async (source) => {
        await withOpenClawTestState({ scenario: "minimal" }, async () => {
          const f = await createFixture(true);
          const spy = vi.spyOn(registration, "registerDurableQuestion");
          try {
            manager.request({
              id: "collision",
              questions: requestParams.questions,
              timeoutMs: 1000,
              agentId: source === "same-agent" ? requestParams.agentId : "other",
            });
            const response = await f.call(
              "question.request",
              { ...requestParams, id: "collision", durable: true },
              f.runtime,
            );
            expect(response[0]).toBe(false);
            expect(spy).not.toHaveBeenCalled();
            expect(manager.hasDurableCustody("collision")).toBe(false);
          } finally {
            spy.mockRestore();
            await f.close();
          }
        });
      },
    );

    it("reserves before worker awaits so competing durable and transient requests cannot orphan custody", async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createFixture(true);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const original = registration.registerDurableQuestion;
        const spy = vi
          .spyOn(registration, "registerDurableQuestion")
          .mockImplementation(async (params) => {
            entered.resolve();
            await release.promise;
            return original(params);
          });
        try {
          const pending = f.call(
            "question.request",
            { ...requestParams, id: "reserved", durable: true },
            f.runtime,
          );
          await entered.promise;
          expect(() => manager.request({ id: "reserved", questions: [], timeoutMs: 1000 })).toThrow(
            "already exists",
          );
          const duplicate = await f.call(
            "question.request",
            { ...requestParams, id: "reserved", durable: true },
            f.runtime,
          );
          expect(duplicate[0]).toBe(false);
          expect(spy).toHaveBeenCalledTimes(1);
          release.resolve();
          expect((await pending)[0]).toBe(true);
          expect(manager.hasDurableCustody("reserved")).toBe(true);
        } finally {
          release.resolve();
          spy.mockRestore();
          await f.close();
        }
      });
    });
  });
  it.each([true, false])(
    "explains legacy conversation recovery only to its authorized requester (%s)",
    async (authorized) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };
        const foreignOwner = authorized
          ? undefined
          : ensureProfileForEmail("other-legacy-owner@example.test");
        const f = await createFixture(true, true, foreignOwner?.id);
        try {
          const before = loadSessionEntry(sessionScope);
          expect(before?.lifecycleRevision).toBeUndefined();
          expect(before?.createdActor).toEqual(f.entry.createdActor);
          if (foreignOwner) {
            expect(before?.createdActor?.id).toBe(foreignOwner.id);
          }
          const response = await f.call(
            "question.request",
            { ...requestParams, id: "legacy-recovery-action", durable: true },
            f.runtime,
          );
          expect(response[0]).toBe(false);
          expect(response[2]).toMatchObject({
            code: "INVALID_REQUEST",
            message: authorized
              ? expect.stringContaining(
                  "Start a new conversation with /new, or explicitly reset this conversation with /reset",
                )
              : "This question cannot acquire durable conversation custody.",
          });
          expect(loadSessionEntry(sessionScope)).toEqual(before);
          expect(manager.observe("legacy-recovery-action")).toBeNull();
          expect(
            await questionStorage.executeSessionQuestionOperation(
              { ...sessionScope, assertCurrent() {} },
              { kind: "list" },
            ),
          ).toEqual([]);
          expect(broadcast.mock.calls.some(([event]) => event === "question.requested")).toBe(
            false,
          );
        } finally {
          await f.close();
        }
      });
    },
  );
}

export async function writeQuestionFixtureEntry(
  scope: Parameters<typeof upsertSessionEntryCore>[0],
  entry: SessionEntry,
  legacyGeneration: boolean,
) {
  if (legacyGeneration) {
    replaceSessionEntrySync(scope, entry);
  } else {
    await upsertSessionEntryCore(scope, entry);
  }
}
