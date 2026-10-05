import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../gateway/session-sharing-authorization-async.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../../gateway/session-sharing.test-utils.js";
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
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources,
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
    const scope = {
      agentId: "incognito-agent",
      env: { OPENCLAW_STATE_DIR: path.resolve(fixture.sessionsDir(), "../../..") },
      sessionId: "incognito-session",
      sessionKey: "agent:incognito-agent:dashboard:incognito-pending-input",
    };
    await upsertSessionEntryCore(scope, {
      incognito: true,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "Continue in memory",
      timestamp: 100,
      idempotencyKey: "incognito-native:user",
    };
    receipt = await stageSessionPendingInput(scope, {
      runId: "incognito-native",
      message,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected incognito pending input custody");
    }

    expect(
      receipt.run(() => appendTranscriptMessageSync(scope, { message: receipt!.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });
    receipt.finish("cancelled");
    await receipt.settled?.();
    receipt = undefined;

    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ content: message.content }) }),
    );
    expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [], total: 0 });
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

it("keeps staged input and worker persistence under fresh authority without caller SQL", async () => {
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
          appendExpectedSessionTranscriptTurn(scope, {
            expectedSessionId: scope.sessionId,
            sessionFile: "synthetic-custody-session.jsonl",
            messages: [{ message: admitted!.message }],
          }),
        ),
      ).toMatchObject({ appendedMessages: [{ appended: true }] });
      expect(queries).toEqual([]);
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
});
