import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { resolveSessionMutationAuthorizationAsync as authorizeMutation } from "../../gateway/session-sharing-authorization-async.js";
import {
  roleClient,
  rolePolicyConfig,
  sharingPolicyClient,
} from "../../gateway/session-sharing.test-utils.js";
import { withSessionTranscriptWriteLock as withTranscriptLock } from "../../plugin-sdk/session-transcript-runtime.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { StoreWriterTiming } from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptMessage as appendMessage,
  appendTranscriptMessageSync as appendSync,
  loadTranscriptEvents as readTranscript,
  upsertSessionEntryCore as upsertEntry,
} from "./session-accessor.js";
import {
  bindSessionPendingInputSources as bindInputs,
  prepareForeignLiveSessionPendingInputEntries,
  listSessionPendingInputs as listInputs,
  stageSessionPendingInput as stageInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import {
  captureSessionPendingInputWorkerCustody as captureCustody,
  runWithSessionPendingInputWorkerCustody as runWithCustody,
} from "./session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { appendExpectedSessionTranscriptTurn as appendTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.js";
import { useTempSessionsFixture } from "./test-helpers.js";

function message(runId: string, content: string): PersistedUserTurnMessage {
  return { role: "user", content, timestamp: 100, idempotencyKey: `${runId}:user` };
}
async function finish(receipt: SessionPendingInputReceipt | undefined) {
  receipt?.finish("interrupted");
  await receipt?.settled?.();
}
function authorizedInput(
  authorization: NonNullable<Awaited<ReturnType<typeof authorizeMutation>>["authorization"]>,
  runId: string,
  content: string,
  assertCurrent = authorization.assertCurrent,
) {
  return {
    runId,
    message: message(runId, content),
    assertCurrent,
    assertAdmittedCurrent: assertCurrent,
    authority: authorization.admittedInputAuthority,
  };
}
async function authorize(
  requestParams: Parameters<typeof authorizeMutation>[0]["requestParams"],
  client: Parameters<typeof authorizeMutation>[0]["client"],
  cfg = rolePolicyConfig(),
) {
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  const result = await authorizeMutation({ client, method: "chat.send", requestParams, context });
  expect(result.error).toBeNull();
  return result.authorization!;
}

describe("accepted input worker custody", () => {
  afterAll(clearRuntimeConfigSnapshot);
  const fixture = useTempSessionsFixture("openclaw-pending-worker-custody-");
  let receipt: SessionPendingInputReceipt | undefined;

  afterEach(async () => {
    await finish(receipt);
    receipt = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("appends, consumes, and finishes worker custody across a state-directory alias", async () => {
    setRuntimeConfigSnapshot({});
    const fixtureRoot = path.resolve(fixture.sessionsDir(), "../../..");
    const aliasRoot = path.join(fixtureRoot, "state-alias");
    fs.symlinkSync(fixtureRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const scope = {
      agentId: "alias-agent",
      env: { OPENCLAW_STATE_DIR: aliasRoot },
      sessionId: "alias-session",
      sessionKey: "agent:alias-agent:pending-inputs",
    };
    await upsertEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const input = message("worker-alias", "Continue through worker custody");
    receipt = await stageInput(scope, {
      runId: "worker-alias",
      message: input,
      assertCurrent: () => {},
    });
    assert(receipt, "Expected aliased pending input custody");

    const custody = receipt.run(() => captureCustody());
    assert(custody, "Expected captured worker custody");
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    expect(custody.facts.databasePath).toBe(fs.realpathSync(database.path));

    const workerScope = { ...scope, storePath: custody.facts.databasePath };
    const readAlias = await prepareForeignLiveSessionPendingInputEntries(scope);
    const readCanonical = await prepareForeignLiveSessionPendingInputEntries(workerScope);
    expect(readAlias()).toEqual(new Map([[receipt.inputId, input.idempotencyKey]]));
    expect(readCanonical()).toEqual(readAlias());
    expect(
      await receipt.run(async () => (await prepareForeignLiveSessionPendingInputEntries(scope))()),
    ).toEqual(new Map());
    const result = runWithCustody(custody.facts, custody.relocation, custody.assertCurrent, () =>
      appendSync(workerScope, { message: receipt!.message }),
    );
    expect(result.value).toMatchObject({ ok: true, value: { appended: true } });
    custody.publish(result.receipt);
    expect(readAlias()).toEqual(new Map([[receipt.inputId, input.idempotencyKey]]));
    receipt.finish("cancelled");
    expect(readAlias()).toEqual(new Map());
    await receipt.settled?.();
    receipt = undefined;

    expect(await readTranscript(scope)).toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ content: input.content }) }),
    );
    expect(await listInputs(scope)).toMatchObject({ items: [], total: 0 });
  });

  it("appends and finishes pending input through the memory session actor", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async ({ env }) => {
        const scope = {
          agentId: "incognito-agent",
          env,
          sessionId: "incognito-session",
          sessionKey: "agent:incognito-agent:dashboard:incognito-pending-input",
        };
        await upsertEntry(scope, { incognito: true, sessionId: scope.sessionId, updatedAt: 1 });
        const cfg = { ...rolePolicyConfig(), agents: { entries: { "incognito-agent": {} } } };
        const client = roleClient("view", "incognito-custody");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog({ env })).release };
        client.connect.scopes = ["operator.admin"];
        const authorization = await authorize(scope, client, cfg);
        const input = authorizedInput(authorization, "incognito-memory", "Continue in memory");
        try {
          receipt = await stageInput(scope, input);
          const admitted = receipt;
          assert(admitted?.runAsync, "Expected incognito pending input custody");
          const readForeign = await prepareForeignLiveSessionPendingInputEntries(scope);
          expect(readForeign()).toEqual(
            new Map([[admitted.inputId, input.message.idempotencyKey]]),
          );
          await upsertEntry(scope, { sessionId: scope.sessionId, updatedAt: 2 });
          let effects = 0;
          await expect(
            admitted.runAsync(() => {
              effects++;
              return appendMessage(scope, { message: admitted.message });
            }),
          ).resolves.toMatchObject({ appended: true });
          expect(readForeign()).toEqual(
            new Map([[admitted.inputId, input.message.idempotencyKey]]),
          );
          client.connect.scopes = ["operator.read", "operator.write"];
          await expect(
            admitted.runAsync(() => {
              effects++;
            }),
          ).rejects.toThrow("was not found");
          expect(effects).toBe(1);
          // Revoked execution does not let another turn take still-held input.
          expect(readForeign()).toEqual(
            new Map([[admitted.inputId, input.message.idempotencyKey]]),
          );
          admitted.finish("cancelled");
          expect(readForeign()).toEqual(new Map());
          await admitted.settled?.();
          receipt = undefined;

          expect(await readTranscript(scope)).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ content: input.message.content }),
            }),
          );
          expect(await listInputs(scope)).toMatchObject({ items: [], total: 0 });
        } finally {
          await finish(receipt);
          receipt = undefined;
        }
      },
    );
  });
});

it("refreshes every collected source after a non-revoking profile change", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:collected-custody",
      sessionId: "collected-session",
    };
    const first = ensureProfileForEmail("collected-first@example.test");
    const second = ensureProfileForEmail("collected-second@example.test");
    await upsertEntry(scope, {
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
        const authorization = await authorize(
          scope,
          sharingPolicyClient({ user: profile.id }),
          cfg,
        );
        const receipt = await stageInput(
          scope,
          authorizedInput(authorization, `collected-${index}`, `Source ${index}`),
        );
        assert(receipt, "Expected accepted collected source");
        receipts.push(receipt);
      }
      setUserProfileRole(second.id, "write");
      const collected = bindInputs(receipts, message("collected", "Collected sources"));
      assert(collected?.runAsync, "Expected collected input authority");
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
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      const client = roleClient("view", "custody-member");
      const profileId = client.authenticatedUserProfile!.profileId;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:prepared-custody",
        sessionId: "custody-session",
      };
      await upsertEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      await addSessionMember(scope, { identityId: profileId, addedBy: "another-profile" });
      const authorization = await authorize(scope, client, cfg);
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
        admitted = await stageInput(
          scope,
          authorizedInput(
            authorization,
            "prepared-custody",
            "Continue with captured custody",
            assertCurrent,
          ),
        );
        expect(admitted?.state).toBe("queued");
        unsettled = await stageInput(scope, {
          runId: "pending-settlement",
          message: { ...admitted!.message, idempotencyKey: "pending-settlement:user" },
          assertCurrent,
          assertAdmittedCurrent: assertCurrent,
          authority: authorization.admittedInputAuthority,
        });
        assert(unsettled, "Expected accepted settlement custody");
        const run = <T>(operation: () => T) =>
          admitted!.runAsync ? admitted!.runAsync(operation) : admitted!.run(operation);
        const timing: StoreWriterTiming = {};
        await run(() => runOpenClawAgentWorkerWrite(scope, async () => {}, timing));
        expect(timing.reentrant).toBe(false);
        expect(
          await run(() =>
            writer === "turn"
              ? appendTurn(scope, {
                  expectedSessionId: scope.sessionId,
                  sessionFile: "synthetic-custody-session.jsonl",
                  messages: [{ message: admitted!.message }],
                })
              : withTranscriptLock(scope, (locked) =>
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
        assert(
          typeof original?.entry_json === "string" && typeof original.entry_valid === "number",
          "Expected the synthetic canonical session row",
        );
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
        await finish(unsettled);
        await finish(admitted);
      }
    });
  },
);
