import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import {
  appendMessage,
  call,
  client,
  context,
  roleConfig,
  seedSession,
  sessionId,
  sessionKey,
  transcriptScope,
  withReactionState,
} from "./sessions-reactions.test-support.js";

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("reaction access preparation", () => {
  it("lists and commits member reactions without caller-thread SQL", async () => {
    await withReactionState(async () => {
      await seedSession({ visibility: "read-only" });
      addSessionMember(transcriptScope, { identityId: "alice", addedBy: "owner" });
      const messageId = await appendMessage();
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        const requestContext = bindSessionRowProjection(
          context(roleConfig("view")),
          () => projection,
        );
        const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
        const exec = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          expect(
            (
              await call(
                "session.reactions.set",
                { sessionKey, messageId, emoji: "👍" },
                client("alice"),
                requestContext,
              )
            )[0],
          ).toBe(true);
          expect(
            (
              await call("session.reactions.list", { sessionKey }, client("alice"), requestContext)
            )[1],
          ).toMatchObject({
            sessionId,
            reactions: { [messageId]: [{ emoji: "👍", count: 1 }] },
          });
          expect(prepare).not.toHaveBeenCalled();
          expect(exec).not.toHaveBeenCalled();
        } finally {
          prepare.mockRestore();
          exec.mockRestore();
        }
      } finally {
        projection.dispose();
      }
    });
  });

  it("awaits membership preparation and rejects failed or revoked preparations", async () => {
    await withReactionState(async () => {
      await seedSession({ visibility: "read-only" });
      addSessionMember(transcriptScope, { identityId: "alice", addedBy: "owner" });
      const messageId = await appendMessage();
      const requestContext = context();
      await call("session.reactions.list", { sessionKey }, client("alice"), requestContext);
      const projection = getSessionRowProjection(requestContext)!;
      const prepare = projection.prepareMembership.bind(projection);
      for (const outcome of ["ready", "rejected", "profile-changed"] as const) {
        const reactor = client("alice");
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const preparation = vi
          .spyOn(projection, "prepareMembership")
          .mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            if (outcome === "rejected") {
              throw new Error("membership reader unavailable");
            }
            await prepare();
          });
        const read = vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync");
        sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: true });
        const pending = call(
          "session.reactions.set",
          { sessionKey, messageId, emoji: "👍" },
          reactor,
          requestContext,
        );
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "reaction skipped membership preparation",
          );
          expect(read).not.toHaveBeenCalled();
          if (outcome === "profile-changed") {
            reactor.authenticatedUserProfile!.profileId = "bob";
          }
        } finally {
          release.resolve();
        }
        const result = await pending;
        expect(result[0], outcome).toBe(outcome === "ready");
        if (outcome !== "ready") {
          expect(read).not.toHaveBeenCalled();
        }
        preparation.mockRestore();
        read.mockRestore();
      }
    });
  });

  it("rechecks current membership, policy, source, and caller after message preparation", async () => {
    await withReactionState(async () => {
      const readMessage = transcriptReaders.readSessionMessageByIdAsync;
      for (const change of ["member", "dirty", "profile", "policy", "projection", "run"] as const) {
        const key = `agent:main:revoke-${change}`;
        const scope = await seedSession(
          { visibility: "read-only", sessionId: `revoke-${change}` },
          key,
        );
        addSessionMember(scope, { identityId: "alice", addedBy: "owner" });
        const messageId = await appendMessage(undefined, scope);
        let cfg = change === "run" ? {} : roleConfig("view");
        const requestContext = context(cfg);
        requestContext.getRuntimeConfig = () => cfg;
        const reactor = client("alice");
        await call("session.reactions.list", { sessionKey: key }, reactor, requestContext);
        const projection = getSessionRowProjection(requestContext)!;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const read = vi
          .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
          .mockImplementationOnce(async (...args) => {
            const result = await readMessage(...args);
            entered.resolve();
            await release.promise;
            return result;
          });
        let runRevoked = false;
        if (change === "run") {
          reactor.internal = {
            syntheticClient: true,
            operatorRoleActor: { kind: "operator", profileId: "alice" },
            operatorRunAuthority: createAdmittedRunOperatorAuthority({
              profileId: "alice",
              scopes: ["operator.read", "operator.write"],
              assertCurrent: () => {
                if (runRevoked) {
                  throw new Error("reaction run revoked");
                }
              },
            }),
          };
        }
        let invalidateOnCheck = false;
        const pending = call(
          "session.reactions.set",
          { sessionKey: key, messageId, emoji: "👍" },
          reactor,
          requestContext,
          () => {
            if (invalidateOnCheck) {
              invalidateOnCheck = false;
              const target = projection.sharingTarget({ key, agentId: "main" })!;
              sessionChanges.emit({ all: true, scope: "stores" });
              expect(projection.hasMembership(target.storePath, target.storeKey, "alice")).toBe(
                true,
              );
              expect(projection.sharingTargetState({ key, agentId: "main" }).status).toBe(
                "pending",
              );
            }
            return true;
          },
        );
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "reaction did not read its message",
          );
          if (change === "member") {
            removeSessionMember(scope, "alice");
          }
          if (change === "dirty") {
            invalidateOnCheck = true;
          }
          if (change === "profile") {
            reactor.authenticatedUserProfile!.profileId = "bob";
          }
          if (change === "run") {
            runRevoked = true;
          }
          if (change === "policy") {
            cfg = roleConfig("none");
          }
          if (change === "projection") {
            bindSessionRowProjection(requestContext, () => undefined);
          }
        } finally {
          release.resolve();
        }
        expect((await pending)[0], change).toBe(false);
        read.mockRestore();
        expect(requestContext.broadcast).not.toHaveBeenCalled();
        expect(await transcriptReaders.readSessionReactionsAsync(scope)).toEqual({});
      }
    });
  });
  it("does not disclose a list whose session becomes private while reading", async () => {
    await withReactionState(async () => {
      await seedSession();
      const messageId = await appendMessage();
      const requestContext = context();
      await call(
        "session.reactions.set",
        { sessionKey, messageId, emoji: "👍" },
        client("alice"),
        requestContext,
      );
      const readReactions = transcriptReaders.readSessionReactionsAsync;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(transcriptReaders, "readSessionReactionsAsync").mockImplementationOnce(
        async (...args) => {
          const result = await readReactions(...args);
          entered.resolve();
          await release.promise;
          return result;
        },
      );
      const pending = call(
        "session.reactions.list",
        { sessionKey },
        client("alice"),
        requestContext,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "reaction list did not reach its reader",
        );
        await seedSession({ visibility: "draft" });
      } finally {
        release.resolve();
      }
      expect(await pending).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
    });
  });

  it("keeps an absent target bound through asynchronous fallback publication", async () => {
    await withReactionState(async () => {
      await seedSession();
      const requestContext = context();
      await call("session.reactions.list", { sessionKey }, client("alice"), requestContext);
      const key = "agent:main:previously-absent";
      const prepareFacts = sharingPreparation.prepareSessionMutationFacts;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      vi.spyOn(sharingPreparation, "prepareSessionMutationFacts").mockImplementationOnce(
        async (...args) => {
          const result = await prepareFacts(...args);
          entered.resolve();
          await release.promise;
          return result;
        },
      );
      const read = vi.spyOn(transcriptReaders, "readSessionReactionsAsync");
      const pending = call(
        "session.reactions.list",
        { sessionKey: key },
        client("alice"),
        requestContext,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "absent target did not use prepared sharing",
        );
        await seedSession({ sessionId: "new-target" }, key);
      } finally {
        release.resolve();
      }
      expect(await pending).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      expect(read).not.toHaveBeenCalled();
    });
  });
});
