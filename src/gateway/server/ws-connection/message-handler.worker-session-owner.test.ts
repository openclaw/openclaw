import "./message-handler.worker-session-owner.mocks.test-support.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { PreparedSessionMutationFacts } from "../../session-sharing-policy.js";
import * as preparation from "../../session-sharing-preparation.js";
import {
  expectOnlyLegacyWorkerSql,
  OWNER_PARENT,
  OWNER_SIBLING,
  OWNER_SOURCE,
  resultDetails,
  withWorkerOwnerFixture,
} from "./message-handler.worker-session-owner.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("registered worker send session ownership", () => {
  it.each(["per-agent", "fixed"] as const)(
    "routes the raw global parent and its returned key through the %s store owner",
    async (layout) => {
      await withWorkerOwnerFixture(layout, async (fixture) => {
        const sql = fixture.observeSql();
        try {
          const first = resultDetails(await fixture.send("global", "parent-first"));
          expect(first, JSON.stringify(first)).toMatchObject({ status: "accepted" });
          expect(typeof first.sessionKey).toBe("string");
          const followup = resultDetails(
            await fixture.send(String(first.sessionKey), "parent-followup"),
          );
          expect(first).toMatchObject({ status: "accepted", sessionKey: "global" });
          expect(followup, JSON.stringify(followup)).toMatchObject({
            status: "accepted",
            sessionKey: first.sessionKey,
          });
          expect(fixture.dispatched).toEqual([
            {
              agentId: "ops",
              sessionKey: "global",
              message: expect.stringContaining("parent-first"),
            },
            {
              agentId: "ops",
              sessionKey: "global",
              message: expect.stringContaining("parent-followup"),
            },
          ]);
          expectOnlyLegacyWorkerSql(sql);
        } finally {
          sql.restore();
        }
      });
    },
  );

  it("retains the non-default shared parent owner for sibling admission", async () => {
    await withWorkerOwnerFixture("per-agent", async (fixture) => {
      const result = resultDetails(await fixture.send(OWNER_SIBLING.sessionKey, "sibling"));
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "accepted",
        sessionKey: OWNER_SIBLING.sessionKey,
      });
      expect(fixture.dispatched).toEqual([
        {
          agentId: "worker",
          sessionKey: OWNER_SIBLING.sessionKey,
          message: expect.stringContaining("sibling"),
        },
      ]);
    });
  });

  it("keeps direct child authority independent of a replaced ancestor", async () => {
    await withWorkerOwnerFixture("per-agent", async (fixture) => {
      fixture.write(OWNER_PARENT, { sessionId: "replacement-ancestor" });
      fixture.write(OWNER_SIBLING, {
        parentSessionKey: OWNER_SOURCE.sessionKey,
        parentSessionId: OWNER_SOURCE.sessionId,
      });
      const result = resultDetails(await fixture.send(OWNER_SIBLING.sessionKey, "direct-child"));
      expect(result, JSON.stringify(result)).toMatchObject({ status: "accepted" });
      expect(fixture.dispatched).toHaveLength(1);
      expect(fixture.dispatched[0]).toMatchObject({
        agentId: "worker",
        sessionKey: OWNER_SIBLING.sessionKey,
      });
    });
  });

  it.each(["before-admission", "after-acceptance"] as const)(
    "retains the ordinary send's sibling-lineage boundary at %s",
    async (phase) => {
      await withWorkerOwnerFixture("per-agent", async (fixture) => {
        fixture.write(OWNER_SIBLING, { lifecycleRevision: "stable-sibling-admission" });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const createFacade = expectDefined(
          fixture.context.createAgentTurnFacade,
          "worker Gateway turn facade",
        );
        const probe = vi
          .spyOn(fixture.context, "createAgentTurnFacade")
          .mockImplementation(async (principal) => {
            const facade = await createFacade(principal);
            if (phase === "before-admission") {
              entered.resolve();
              await release.promise;
              return facade;
            }
            const dispatch: typeof facade.dispatch = async <T>(
              ...args: Parameters<typeof facade.dispatch>
            ) => {
              const result = await facade.dispatch<T>(...args);
              entered.resolve();
              await release.promise;
              return result;
            };
            return { ...facade, dispatch };
          });
        const pending = fixture.send(OWNER_SIBLING.sessionKey, "sibling-admission");
        try {
          await Promise.race([
            entered.promise,
            pending.then((response) => {
              throw new Error(
                `Send finished before facade preparation: ${JSON.stringify(response)}`,
              );
            }),
          ]);
          fixture.write(OWNER_SIBLING, {
            parentSessionKey: "agent:main:unrelated",
            parentSessionId: "unrelated-parent",
          });
          release.resolve();
          const result = resultDetails(await pending);
          expect(result, JSON.stringify({ result, dispatched: fixture.dispatched })).toMatchObject({
            status: phase === "before-admission" ? "error" : "accepted",
          });
          expect(fixture.dispatched).toHaveLength(phase === "before-admission" ? 0 : 1);
        } finally {
          release.resolve();
          await pending.catch(() => undefined);
          probe.mockRestore();
        }
      });
    },
  );

  it.each([
    { outcome: "accepted" },
    { outcome: "unsupported" },
    { outcome: "source revoked", pause: "prepare" },
    { outcome: "source revoked", pause: "commit" },
    { outcome: "parent archived", pause: "prepare" },
    { outcome: "parent archived", pause: "commit" },
  ] as const)(
    "keeps queued worker input authoritative for $outcome at $pause",
    async (testCase) => {
      await withWorkerOwnerFixture("per-agent", async (fixture) => {
        const queued = await fixture.installQueuedSibling({
          supportsTranscriptCommitWait: testCase.outcome !== "unsupported",
          ...("pause" in testCase ? { pause: testCase.pause } : {}),
        });
        expect(queued.messages()).toEqual([]);
        const pending = fixture.send(queued.target.sessionKey, "queued-owner-input");
        try {
          if ("pause" in testCase) {
            await Promise.race([
              queued.entered,
              pending.then((response) => {
                throw new Error(
                  `Queued send finished before its ${testCase.pause} boundary: ${JSON.stringify(response)}`,
                );
              }),
            ]);
            if (testCase.outcome === "source revoked") {
              fixture.revokeSource();
            } else {
              fixture.write(OWNER_PARENT, { archivedAt: 2 });
            }
            queued.release();
          }
          const result = resultDetails(await pending);
          if (testCase.outcome === "accepted") {
            expect(result).toMatchObject({
              status: "accepted",
              targetDisposition: "steered",
              sessionKey: queued.target.sessionKey,
            });
            expect(queued.accepted).toBe(1);
            expect(queued.messages()).toEqual([
              expect.objectContaining({
                message: expect.objectContaining({
                  role: "user",
                  content: expect.stringContaining("Synthetic queued-owner-input"),
                  provenance: expect.objectContaining({
                    sourceTool: "sessions_send",
                    sourceSessionKey: OWNER_SOURCE.sessionKey,
                  }),
                }),
              }),
            ]);
          } else {
            expect(result).toMatchObject({ status: "error" });
            expect(queued.messages()).toEqual([]);
            if (testCase.outcome === "unsupported") {
              expect(result.error).toEqual(
                expect.stringContaining("transcript_commit_wait_unsupported"),
              );
              expect(queued.queueMessage).not.toHaveBeenCalled();
              expect(queued.accepted).toBe(0);
            } else {
              expect(queued.queueMessage).toHaveBeenCalledOnce();
              expect(queued.accepted).toBe(testCase.pause === "commit" ? 1 : 0);
            }
          }
          expect(fixture.dispatched).toEqual([]);
        } finally {
          queued.release();
          await pending.catch(() => undefined);
        }
      });
    },
  );

  it.each(["missing", "replaced", "archived", "ambiguous"] as const)(
    "rejects a %s parent before direct or sibling dispatch",
    async (condition) => {
      await withWorkerOwnerFixture("per-agent", async (fixture) => {
        if (condition === "missing") {
          fixture.write(OWNER_SOURCE, { parentSessionId: "missing-parent" });
          fixture.write(OWNER_SIBLING, { parentSessionId: "missing-parent" });
        } else if (condition === "replaced") {
          fixture.write(OWNER_PARENT, { sessionId: "replacement-parent" });
        } else if (condition === "archived") {
          fixture.write(OWNER_PARENT, { archivedAt: 2 });
        } else {
          fixture.write(
            { agentId: "main", sessionKey: "global", sessionId: OWNER_PARENT.sessionId },
            {
              sessionId: OWNER_PARENT.sessionId,
            },
          );
        }
        for (const [name, key] of [
          ["parent", "global"],
          ["sibling", OWNER_SIBLING.sessionKey],
        ] as const) {
          const result = resultDetails(await fixture.send(key, `${condition}-${name}`));
          expect(result).toMatchObject({ status: "error" });
          expect(result.error).toEqual(
            expect.stringMatching(
              /exact live session|authorized session tree|facts are unavailable/u,
            ),
          );
        }
        expect(fixture.dispatched).toEqual([]);
      });
    },
  );

  it.each([
    { owner: "source", change: "archive" },
    { owner: "source", change: "lineage" },
    { owner: "source", change: "parent-incarnation" },
    { owner: "source", change: "replace" },
    { owner: "source", change: "revoke" },
    { owner: "target", change: "archive" },
    { owner: "target", change: "lineage" },
    { owner: "target", change: "replace" },
    { owner: "parent", change: "archive" },
    { owner: "parent", change: "replace" },
    { owner: "parent", change: "duplicate" },
  ] as const)(
    "rejects $owner $change committed while prepared sibling facts await",
    async ({ owner, change }) => {
      await withWorkerOwnerFixture(
        "per-agent",
        async (fixture) => {
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const prepare = preparation.prepareSessionMutationFacts;
          type RequiredPreparation = Parameters<typeof prepare>[0];
          type OptionalPreparation = Omit<RequiredPreparation, "allowMissing"> & {
            allowMissing: true;
          };
          type RequiredFacts = Awaited<ReturnType<typeof prepare>>;
          type OptionalFacts = Omit<RequiredFacts, "readCurrent"> & {
            readCurrent(
              this: void,
              cfg: RequiredPreparation["cfg"],
            ): Omit<ReturnType<RequiredFacts["readCurrent"]>, "target"> &
              PreparedSessionMutationFacts;
          };
          const prepareOptional: (params: OptionalPreparation) => Promise<OptionalFacts> = prepare;
          const prepareRequired: (params: RequiredPreparation) => ReturnType<typeof prepare> =
            prepare;
          let held = false;
          let negativeParentPrepared = false;
          function prepareAndHold(params: OptionalPreparation): Promise<OptionalFacts>;
          function prepareAndHold(params: RequiredPreparation): ReturnType<typeof prepare>;
          async function prepareAndHold(params: OptionalPreparation | RequiredPreparation) {
            const facts =
              params.allowMissing === true
                ? await prepareOptional(params)
                : await prepareRequired(params);
            if (
              change === "duplicate" &&
              params.agentId === "main" &&
              params.sessionKey === "global"
            ) {
              expect(facts.readCurrent(fixture.cfg).target).toBeNull();
              negativeParentPrepared = true;
            }
            if (
              !held &&
              params.agentId === OWNER_PARENT.agentId &&
              params.sessionKey === OWNER_PARENT.sessionKey
            ) {
              held = true;
              entered.resolve();
              await release.promise;
            }
            return facts;
          }
          const intercept = vi
            .spyOn(preparation, "prepareSessionMutationFacts")
            .mockImplementation(prepareAndHold);
          const pending = fixture.send(
            change === "parent-incarnation" ? "global" : OWNER_SIBLING.sessionKey,
            `${owner}-${change}`,
          );
          try {
            await Promise.race([
              entered.promise,
              pending.then((response) => {
                throw new Error(
                  `Worker send finished before the preparation boundary: ${JSON.stringify(response)}`,
                );
              }),
            ]);
            if (change === "revoke") {
              fixture.revokeSource();
            } else if (change === "duplicate") {
              expect(negativeParentPrepared).toBe(true);
              fixture.write(
                { agentId: "main", sessionKey: "global", sessionId: OWNER_PARENT.sessionId },
                {
                  sessionId: OWNER_PARENT.sessionId,
                },
              );
            } else {
              const identity =
                owner === "source"
                  ? OWNER_SOURCE
                  : owner === "target"
                    ? OWNER_SIBLING
                    : OWNER_PARENT;
              fixture.write(
                identity,
                change === "archive"
                  ? { archivedAt: 2 }
                  : change === "replace"
                    ? { sessionId: `replacement-${owner}` }
                    : change === "parent-incarnation"
                      ? { parentSessionId: "unrelated-parent" }
                      : {
                          parentSessionId: "unrelated-parent",
                          parentSessionKey: "agent:main:unrelated",
                        },
              );
            }
            release.resolve();
            const response = await pending;
            if (response.ok) {
              const result = resultDetails(response);
              expect(
                result,
                JSON.stringify({ result, dispatched: fixture.dispatched }),
              ).toMatchObject({
                status: "error",
              });
            } else {
              expect(response.error).toMatchObject({ details: { reason: "placement-mismatch" } });
            }
            expect(fixture.dispatched).toEqual([]);
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
            intercept.mockRestore();
          }
        },
        { mainGlobalAbsent: change === "duplicate" },
      );
    },
  );
});
