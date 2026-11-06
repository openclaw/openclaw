import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.native.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  bindSessionRowProjection,
  getSessionRowProjection,
} from "../session-row-projection-access.js";
import * as sharingPreparation from "../session-sharing-preparation.js";
import * as transcriptReaders from "../session-transcript-readers.js";
import {
  appendMessage,
  setReaction,
  listReactions,
  client,
  context,
  roleConfig,
  reactionGate,
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

it("lists and commits member reactions without caller-thread SQL", () =>
  withReactionState(async () => {
    await seedSession({ visibility: "read-only" });
    addSessionMember(transcriptScope, { identityId: "alice", addedBy: "owner" });
    const messageId = await appendMessage();
    const requestContext = context(roleConfig("view"));
    await listReactions(client("alice"), requestContext);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect((await setReaction(messageId, {}, client("alice"), requestContext))[0]).toBe(true);
    expect((await listReactions(client("alice"), requestContext))[1]).toMatchObject({
      sessionId,
      reactions: { [messageId]: [{ emoji: "👍", count: 1 }] },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  }));

it("awaits membership preparation and rejects failed or revoked preparations", () =>
  withReactionState(async () => {
    await seedSession({ visibility: "read-only" });
    addSessionMember(transcriptScope, { identityId: "alice", addedBy: "owner" });
    const messageId = await appendMessage();
    const requestContext = context();
    await listReactions(client("alice"), requestContext);
    const projection = getSessionRowProjection(requestContext)!;
    const prepare = projection.prepareMembership.bind(projection);
    for (const outcome of ["ready", "rejected", "profile-changed"] as const) {
      const reactor = client("alice");
      const gate = reactionGate();
      const preparation = vi
        .spyOn(projection, "prepareMembership")
        .mockImplementationOnce(async () => {
          await gate.wait();
          if (outcome === "rejected") {
            throw new Error("membership reader unavailable");
          }
          await prepare();
        });
      const read = vi.spyOn(transcriptReaders, "readSessionMessageByIdAsync");
      sessionChanges.emit({ agentId: "main", sessionKey, factsInvalidated: true });
      const pending = setReaction(messageId, {}, reactor, requestContext);
      try {
        await awaitGateBeforeSettlement(
          gate.entered,
          pending,
          "reaction skipped membership preparation",
        );
        expect(read).not.toHaveBeenCalled();
        if (outcome === "profile-changed") {
          reactor.authenticatedUserProfile!.profileId = "bob";
        }
      } finally {
        gate.release();
      }
      const result = await pending;
      expect(result[0], outcome).toBe(outcome === "ready");
      if (outcome !== "ready") {
        expect(read).not.toHaveBeenCalled();
      }
      preparation.mockRestore();
      read.mockRestore();
    }
  }));

it("rechecks current membership, policy, source, and caller after message preparation", () =>
  withReactionState(async () => {
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
      await listReactions(reactor, requestContext, key);
      const projection = getSessionRowProjection(requestContext)!;
      const gate = reactionGate();
      const read = vi
        .spyOn(transcriptReaders, "readSessionMessageByIdAsync")
        .mockImplementationOnce((...args) => gate.hold(readMessage(...args)));
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
      const pending = setReaction(messageId, { sessionKey: key }, reactor, requestContext, () => {
        if (invalidateOnCheck) {
          invalidateOnCheck = false;
          const target = projection.sharingTarget({ key, agentId: "main" })!;
          sessionChanges.emit({ all: true, scope: "stores" });
          expect(projection.hasMembership(target.storePath, target.storeKey, "alice")).toBe(true);
          expect(projection.sharingTargetState({ key, agentId: "main" }).status).toBe("pending");
        }
        return true;
      });
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "reaction did not read its message");
        if (change === "member") {
          removeSessionMember(scope, "alice");
        }
        invalidateOnCheck = change === "dirty";
        if (change === "profile") {
          reactor.authenticatedUserProfile!.profileId = "bob";
        }
        runRevoked = change === "run";
        cfg = change === "policy" ? roleConfig("none") : cfg;
        if (change === "projection") {
          bindSessionRowProjection(requestContext, () => undefined);
        }
      } finally {
        gate.release();
      }
      expect((await pending)[0], change).toBe(false);
      read.mockRestore();
      expect(requestContext.broadcast).not.toHaveBeenCalled();
      expect(await transcriptReaders.readSessionReactionsAsync(scope)).toEqual({});
    }
  }));
it.each(["private", "previously-absent"] as const)(
  "does not disclose a list whose target changes during preparation (%s)",
  (change) =>
    withReactionState(async () => {
      await seedSession();
      const messageId = change === "private" ? await appendMessage() : undefined;
      const requestContext = context();
      const key = change === "private" ? sessionKey : "agent:main:previously-absent";
      if (change === "private") {
        await setReaction(messageId!, {}, client("alice"), requestContext);
      } else {
        await listReactions(client("alice"), requestContext);
      }
      const gate = reactionGate();
      const readReactions = transcriptReaders.readSessionReactionsAsync;
      const read = vi.spyOn(transcriptReaders, "readSessionReactionsAsync");
      if (change === "private") {
        read.mockImplementationOnce((...args) => gate.hold(readReactions(...args)));
      } else {
        const prepareFacts = sharingPreparation.prepareSessionMutationFacts;
        vi.spyOn(sharingPreparation, "prepareSessionMutationFacts").mockImplementationOnce(
          (...args) => gate.hold(prepareFacts(...args)),
        );
      }
      const pending = listReactions(client("alice"), requestContext, key);
      try {
        await awaitGateBeforeSettlement(gate.entered, pending, "list reader not reached");
        await seedSession(
          change === "private" ? { visibility: "draft" } : { sessionId: "new-target" },
          key,
        );
      } finally {
        gate.release();
      }
      expect(await pending).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
      if (change === "previously-absent") {
        expect(read).not.toHaveBeenCalled();
      }
    }),
);
