import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { authenticatedProfileUnavailableError } from "../../gateway/server-methods/gateway-client-identity.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { SessionSharingProfileFactsChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "../../gateway/session-sharing-authorization-async.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../../gateway/session-sharing.test-utils.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withSessionTranscriptWriteLock } from "../../plugin-sdk/session-transcript-runtime.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { StoreWriterTiming } from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
  getForeignLiveSessionPendingInputEntries,
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import {
  captureSessionPendingInputWorkerCustody,
  runWithSessionPendingInputWorkerCustody,
} from "./session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("accepted input worker custody", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-worker-custody-");
  let receipt: SessionPendingInputReceipt | undefined;

  afterEach(async () => {
    receipt?.finish("interrupted");
    await receipt?.settled?.();
    receipt = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("appends, consumes, and finishes worker custody across a state-directory alias", async () => {
    const fixtureRoot = path.resolve(fixture.sessionsDir(), "../../..");
    const aliasRoot = path.join(fixtureRoot, "state-alias");
    fs.symlinkSync(fixtureRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const scope = {
      agentId: "alias-agent",
      env: { OPENCLAW_STATE_DIR: aliasRoot },
      sessionId: "alias-session",
      sessionKey: "agent:alias-agent:pending-inputs",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "Continue through worker custody",
      timestamp: 100,
      idempotencyKey: "worker-alias:user",
    };
    receipt = await stageSessionPendingInput(scope, {
      runId: "worker-alias",
      message,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected aliased pending input custody");
    }

    const custody = receipt.run(() => captureSessionPendingInputWorkerCustody());
    if (!custody) {
      throw new Error("Expected captured worker custody");
    }
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    expect(custody.facts.databasePath).toBe(fs.realpathSync(database.path));

    const workerScope = { ...scope, storePath: custody.facts.databasePath };
    const result = runWithSessionPendingInputWorkerCustody(
      custody.facts,
      custody.relocation,
      custody.assertCurrent,
      () => appendTranscriptMessageSync(workerScope, { message: receipt!.message }),
    );
    expect(result.value).toMatchObject({ ok: true, value: { appended: true } });
    custody.publish(result.receipt);
    receipt.finish("cancelled");
    await receipt.settled?.();
    receipt = undefined;

    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ content: message.content }) }),
    );
    expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [], total: 0 });
  });

  it("appends and finishes pending input through the native incognito owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = {
        agentId: "incognito-agent",
        env,
        sessionId: "incognito-session",
        sessionKey: "agent:incognito-agent:dashboard:incognito-pending-input",
      };
      await upsertSessionEntryCore(scope, {
        incognito: true,
        sessionId: scope.sessionId,
        updatedAt: 1,
      });
      const cfg = {
        ...rolePolicyConfig(),
        agents: { entries: { "incognito-agent": {} } },
      };
      const client = roleClient("view", "incognito-custody");
      client.connect.scopes = ["operator.admin"];
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => cfg;
      context.getCommittedRuntimeConfig = () => cfg;
      const resolved = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context,
      });
      expect(resolved.error).toBeNull();
      const authorization = resolved.authorization!;
      const message: PersistedUserTurnMessage = {
        role: "user",
        content: "Continue in memory",
        timestamp: 100,
        idempotencyKey: "incognito-native:user",
      };
      try {
        receipt = await stageSessionPendingInput(scope, {
          runId: "incognito-native",
          message,
          assertCurrent: authorization.assertCurrent,
          assertAdmittedCurrent: authorization.assertCurrent,
          authority: authorization.admittedInputAuthority,
        });
        const admitted = receipt;
        if (!admitted?.runAsync) {
          throw new Error("Expected incognito pending input custody");
        }
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 2 });
        let effects = 0;
        await expect(
          admitted.runAsync(() => {
            effects++;
            return appendTranscriptMessageSync(scope, { message: admitted.message });
          }),
        ).resolves.toMatchObject({ ok: true, value: { appended: true } });
        client.connect.scopes = ["operator.read", "operator.write"];
        await expect(
          admitted.runAsync(() => {
            effects++;
          }),
        ).rejects.toThrow("was not found");
        expect(effects).toBe(1);
        admitted.finish("cancelled");
        await admitted.settled?.();
        receipt = undefined;

        expect(await loadTranscriptEvents(scope)).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({ content: message.content }),
          }),
        );
        expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [], total: 0 });
      } finally {
        receipt?.finish("interrupted");
        await receipt?.settled?.();
        receipt = undefined;
      }
    });
  });
});

async function withForeignCustody(
  run: (fixture: {
    scope: { agentId: string; sessionKey: string; sessionId: string };
    stage: (id: string) => Promise<{
      receipt: SessionPendingInputReceipt;
      profileId: string;
      authority: NonNullable<SessionPendingInputReceiptAuthority>;
    }>;
    receipts: SessionPendingInputReceipt[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:foreign-custody",
      sessionId: "foreign-session",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "another-profile" },
    });
    const receipts: SessionPendingInputReceipt[] = [];
    const stage = async (id: string) => {
      const profile = ensureProfileForEmail(`foreign-${id}@example.test`);
      setUserProfileRole(profile.id, "view");
      const client = sharingPolicyClient({ user: profile.id });
      const profileId = profile.id;
      await addSessionMember(scope, { identityId: profileId, addedBy: "another-profile" });
      const resolved = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(resolved.error).toBeNull();
      const authorization = resolved.authorization!;
      const receipt = await stageSessionPendingInput(scope, {
        runId: `foreign-${id}`,
        message: {
          role: "user",
          content: `Original request ${id}`,
          timestamp: 100,
          idempotencyKey: `foreign-${id}:user`,
        },
        assertCurrent: authorization.assertCurrent,
        assertAdmittedCurrent: authorization.assertCurrent,
        authority: authorization.admittedInputAuthority,
      });
      if (!receipt?.runAsync || !authorization.admittedInputAuthority) {
        throw new Error("Expected worker-prepared authorized custody");
      }
      receipts.push(receipt);
      return { receipt, profileId, authority: authorization.admittedInputAuthority };
    };
    try {
      await run({ scope, stage, receipts });
    } finally {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(receipts.map(async (receipt) => receipt.settled?.()));
    }
  });
}

type SessionPendingInputReceiptAuthority = Parameters<
  typeof stageSessionPendingInput
>[1]["authority"];

it("discovers authorized foreign live input without host SQL and observes revocation", async () => {
  await withForeignCustody(async ({ scope, stage }) => {
    const { receipt, profileId } = await stage("member");
    const host = observeHostDataSql();
    try {
      expect(await getForeignLiveSessionPendingInputEntries(scope)).toEqual(
        new Map([[receipt.inputId, "foreign-member:user"]]),
      );
      expect(host.queries).toEqual([]);
    } finally {
      host.restore();
    }
    expect(await receipt.runAsync!(() => getForeignLiveSessionPendingInputEntries(scope))).toEqual(
      new Map(),
    );
    await removeSessionMember(scope, profileId);
    expect(await getForeignLiveSessionPendingInputEntries(scope)).toEqual(new Map());
  });
});

it.each([
  "revoked",
  "finished",
  "rotated",
  "cancelled",
  "registered",
  "promoted",
  "profile-changed",
  "non-provider-profile-changed",
  "repeated-profile-changed",
  "current-promoted",
  "aggregate-revoked",
] as const)(
  "rechecks foreign custody after %s during another owner's authority preparation",
  async (change) => {
    await withForeignCustody(async ({ scope, stage, receipts }) => {
      const first = await stage("first");
      const second = await stage("second");
      let aggregateMember: string | undefined;
      if (change === "aggregate-revoked") {
        const third = await stage("aggregate-source");
        aggregateMember = third.profileId;
        const aggregate = bindSessionPendingInputSources([first.receipt, third.receipt], {
          role: "user",
          content: "Collected requests",
          timestamp: 100,
          idempotencyKey: "foreign-aggregate:user",
        })!;
        receipts.push(aggregate);
        await aggregate.runAsync!(() =>
          appendTranscriptMessage(scope, { message: aggregate.message }),
        );
      }
      const entered = createDeferred();
      const release = createDeferred();
      const enteredAgain = createDeferred();
      const releaseAgain = createDeferred();
      const profileRace =
        change === "non-provider-profile-changed" || change === "repeated-profile-changed";
      const provider = profileRace ? first : second;
      const original = provider.authority.withCurrent.bind(provider.authority);
      let preparations = 0;
      const held = vi
        .spyOn(provider.authority, "withCurrent")
        .mockImplementation(async (consume) => {
          preparations++;
          if (preparations === (profileRace ? 2 : 1)) {
            entered.resolve();
            await release.promise;
          } else if (change === "repeated-profile-changed" && preparations === 4) {
            enteredAgain.resolve();
            await releaseAgain.promise;
          }
          return original(consume);
        });
      const controller = new AbortController();
      const discover = () => getForeignLiveSessionPendingInputEntries(scope, controller.signal);
      const pending =
        change === "current-promoted" ? first.receipt.runAsync!(discover) : discover();
      const outcome = pending.then(
        (entries) => ({ entries }),
        (error: unknown) => ({ error }),
      );
      try {
        await entered.promise;
        const expected = new Map([[second.receipt.inputId, "foreign-second:user"]]);
        if (change === "revoked") {
          await removeSessionMember(scope, first.profileId);
        } else if (change === "aggregate-revoked") {
          await removeSessionMember(scope, aggregateMember!);
        } else if (change === "finished") {
          first.receipt.finish("interrupted");
        } else if (change === "rotated") {
          rotateAgentEventLifecycleGeneration();
          expected.clear();
        } else if (change === "cancelled") {
          controller.abort(new Error("Cancelled foreign discovery"));
        } else if (change === "promoted" || change === "current-promoted") {
          const aggregate = bindSessionPendingInputSources([first.receipt], {
            role: "user",
            content: "Promoted request",
            timestamp: 100,
            idempotencyKey: "foreign-promoted:user",
          })!;
          receipts.push(aggregate);
          const promoted = await aggregate.runAsync!(() =>
            appendTranscriptMessage(scope, { message: aggregate.message }),
          );
          expect(promoted).toBeDefined();
          if (change === "promoted") {
            expected.set(promoted!.messageId, "foreign-promoted:user");
          }
        } else {
          expected.set(first.receipt.inputId, "foreign-first:user");
          if (change === "registered") {
            const late = await stage("late");
            expected.set(late.receipt.inputId, "foreign-late:user");
          } else {
            setUserProfileRole(profileRace ? second.profileId : first.profileId, "write");
          }
        }
        release.resolve();
        if (change === "repeated-profile-changed") {
          await enteredAgain.promise;
          setUserProfileRole(second.profileId, "view");
          releaseAgain.resolve();
          expect(await outcome).toMatchObject({ error: expect.any(Error) });
          expect(await getForeignLiveSessionPendingInputEntries(scope)).toEqual(expected);
        } else if (change === "cancelled") {
          expect(await outcome).toMatchObject({ error: new Error("Cancelled foreign discovery") });
        } else {
          expect(await outcome).toEqual({ entries: expected });
        }
      } finally {
        release.resolve();
        releaseAgain.resolve();
        await outcome;
        held.mockRestore();
      }
    });
  },
);

it.each([
  { failure: "worker", phase: "preparation" },
  { failure: "worker", phase: "collection" },
  { failure: "profile", phase: "preparation" },
  { failure: "profile", phase: "collection" },
] as const)(
  "keeps live foreign custody when $failure authority fails during $phase",
  async ({ failure, phase }) => {
    await withForeignCustody(async ({ scope, stage }) => {
      const first = await stage("first");
      const second = await stage("second");
      const error =
        failure === "worker"
          ? new Error("Synthetic sharing worker failure")
          : new SessionSharingProfileFactsChangedError(
              authenticatedProfileUnavailableError(),
              () => ({}),
            );
      const original = first.authority.withCurrent.bind(first.authority);
      let calls = 0;
      const held = vi.spyOn(first.authority, "withCurrent").mockImplementation(async (consume) => {
        calls++;
        if (calls === (phase === "preparation" ? 1 : 2)) {
          throw error;
        }
        return original(consume);
      });
      try {
        // Inconclusive authority cannot prove that the still-live request released its input.
        await expect(getForeignLiveSessionPendingInputEntries(scope)).rejects.toBe(error);
      } finally {
        held.mockRestore();
      }
      expect(await getForeignLiveSessionPendingInputEntries(scope)).toEqual(
        new Map([
          [first.receipt.inputId, "foreign-first:user"],
          [second.receipt.inputId, "foreign-second:user"],
        ]),
      );
    });
  },
);

it("releases a revoked foreign owner after its earlier profile refresh", async () => {
  await withForeignCustody(async ({ scope, stage }) => {
    const provider = await stage("provider");
    const refreshed = await stage("refreshed");
    const original = provider.authority.withCurrent.bind(provider.authority);
    let calls = 0;
    // Calls 2 and 4 collect for every owner; each change lands after that pass's preparation.
    const held = vi.spyOn(provider.authority, "withCurrent").mockImplementation(async (consume) => {
      calls++;
      if (calls === 2) {
        // Membership still grants access; only the prepared profile facts become stale.
        setUserProfileRole(refreshed.profileId, "suggest");
      } else if (calls === 4) {
        await removeSessionMember(scope, refreshed.profileId);
      }
      return original(consume);
    });
    try {
      expect(await getForeignLiveSessionPendingInputEntries(scope)).toEqual(
        new Map([[provider.receipt.inputId, "foreign-provider:user"]]),
      );
      expect(calls).toBe(4);
    } finally {
      held.mockRestore();
    }
  });
});

it("refreshes every collected source after a non-revoking profile change", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = rolePolicyConfig();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:collected-custody",
      sessionId: "collected-session",
    };
    const first = ensureProfileForEmail("collected-first@example.test");
    const second = ensureProfileForEmail("collected-second@example.test");
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "another-profile" },
    });
    const receipts: SessionPendingInputReceipt[] = [];
    try {
      for (const [index, profile] of [first, second].entries()) {
        setUserProfileRole(profile.id, "view");
        await addSessionMember(scope, { identityId: profile.id, addedBy: "another-profile" });
        const result = await resolveSessionMutationAuthorizationAsync({
          client: sharingPolicyClient({ user: profile.id }),
          method: "chat.send",
          requestParams: scope,
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        });
        expect(result.error).toBeNull();
        const authorization = result.authorization!;
        const receipt = await stageSessionPendingInput(scope, {
          runId: `collected-${index}`,
          message: {
            role: "user",
            content: `Source ${index}`,
            timestamp: 100,
            idempotencyKey: `collected-${index}:user`,
          },
          assertCurrent: authorization.assertCurrent,
          assertAdmittedCurrent: authorization.assertCurrent,
          authority: authorization.admittedInputAuthority,
        });
        if (!receipt) {
          throw new Error("Expected accepted collected source");
        }
        receipts.push(receipt);
      }
      setUserProfileRole(second.id, "write");
      const collected = bindSessionPendingInputSources(receipts, {
        role: "user",
        content: "Collected sources",
        timestamp: 100,
        idempotencyKey: "collected:user",
      });
      if (!collected?.runAsync) {
        throw new Error("Expected collected input authority");
      }
      let executed = 0;
      await collected.runAsync(() => {
        executed++;
      });
      expect(executed).toBe(1);
      setUserProfileRole(second.id, "view");
      await removeSessionMember(scope, second.id);
      await expect(
        collected.runAsync(() => {
          executed++;
        }),
      ).rejects.toThrow("session is read-only");
      expect(executed).toBe(1);
    } finally {
      for (const receipt of receipts) {
        receipt.finish("interrupted");
      }
      await Promise.all(
        receipts.flatMap((receipt) => (receipt.settled ? [receipt.settled()] : [])),
      );
    }
  });
});

it.each(["turn", "locked"] as const)(
  "keeps staged input and %s persistence under fresh authority without caller session SQL",
  async (writer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const client = roleClient("view", "custody-member");
      const profileId = client.authenticatedUserProfile!.profileId;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:prepared-custody",
        sessionId: "custody-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(scope, { identityId: profileId, addedBy: "another-profile" });
      const resolved = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(resolved.error).toBeNull();
      const authorization = resolved.authorization!;
      const queries: string[] = [];
      const assertCurrent = () => {
        const host = observeHostDataSql();
        try {
          authorization.assertCurrent();
        } finally {
          queries.push(...host.queries);
          host.restore();
        }
      };
      let admitted: SessionPendingInputReceipt | undefined;
      let unsettled: SessionPendingInputReceipt | undefined;
      try {
        admitted = await stageSessionPendingInput(scope, {
          runId: "prepared-custody",
          message: {
            role: "user",
            content: "Continue with captured custody",
            timestamp: 100,
            idempotencyKey: "prepared-custody:user",
          },
          assertCurrent,
          assertAdmittedCurrent: assertCurrent,
          authority: authorization.admittedInputAuthority,
        });
        expect(admitted?.state).toBe("queued");
        unsettled = await stageSessionPendingInput(scope, {
          runId: "pending-settlement",
          message: { ...admitted!.message, idempotencyKey: "pending-settlement:user" },
          assertCurrent,
          assertAdmittedCurrent: assertCurrent,
          authority: authorization.admittedInputAuthority,
        });
        if (!unsettled) {
          throw new Error("Expected accepted settlement custody");
        }
        const run = <T>(operation: () => T) =>
          admitted!.runAsync ? admitted!.runAsync(operation) : admitted!.run(operation);
        const timing: StoreWriterTiming = {};
        await run(() => runOpenClawAgentWorkerWrite(scope, async () => {}, timing));
        expect(timing.reentrant).toBe(false);
        expect(
          await run(() =>
            writer === "turn"
              ? appendExpectedSessionTranscriptTurn(scope, {
                  expectedSessionId: scope.sessionId,
                  sessionFile: "synthetic-custody-session.jsonl",
                  messages: [{ message: admitted!.message }],
                })
              : withSessionTranscriptWriteLock(scope, (locked) =>
                  locked.appendMessage({
                    message: {
                      ...admitted!.message,
                      custom: {
                        toJSON() {
                          throw new Error("Accepted custody must not serialize supplied input");
                        },
                      },
                    },
                  }),
                ).then((result) => ({ appendedMessages: [result] })),
          ),
        ).toMatchObject({ appendedMessages: [{ appended: true, message: admitted!.message }] });
        expect(
          writer === "turn"
            ? queries
            : queries.filter((query) => /\b(?:session_nodes|session_members)\b/.test(query)),
        ).toEqual([]);
        await removeSessionMember(scope, profileId);
        let dispatched = false;
        await expect(
          Promise.resolve().then(() =>
            run(() => {
              dispatched = true;
            }),
          ),
        ).rejects.toThrow();
        expect(dispatched).toBe(false);
        const database = openOpenClawAgentDatabase(scope);
        const original = database.db
          .prepare("SELECT entry_json, entry_valid FROM session_nodes WHERE session_key = ?")
          .get(scope.sessionKey);
        if (typeof original?.entry_json !== "string" || typeof original.entry_valid !== "number") {
          throw new Error("Expected the synthetic canonical session row");
        }
        const update = database.db.prepare(
          "UPDATE session_nodes SET entry_json = ?, entry_valid = ? WHERE session_key = ?",
        );
        try {
          update.run("{", 1, scope.sessionKey);
          unsettled.finish("interrupted");
          await unsettled.settled?.();
          expect(
            database.db
              .prepare("SELECT state FROM session_pending_inputs WHERE input_id = ?")
              .get(unsettled.inputId)?.state,
          ).toBe("interrupted");
        } finally {
          update.run(original.entry_json, original.entry_valid, scope.sessionKey);
        }
      } finally {
        unsettled?.finish("interrupted");
        await unsettled?.settled?.();
        admitted?.finish("interrupted");
        await admitted?.settled?.();
      }
    });
  },
);
