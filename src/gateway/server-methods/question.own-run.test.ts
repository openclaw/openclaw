import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareSqliteScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import * as questionStorage from "../../config/sessions/session-questions.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import * as questionChannel from "../../infra/question-channel-runtime.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { canReceivePreparedSessionEvent } from "../session-sharing.test-utils.js";
import * as questionRegistration from "./question.durable-registration.js";
import { createOwnRunFixture } from "./question.own-run.test-support.js";
import * as questionFixture from "./question.registration-collision.test-harness.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc,
  createQuestionTestPeer,
  manager,
  requestParams,
  secretRequestParams,
  secretRequestQuestion,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

questionFixture.registerQuestionCollisionTests(createOwnRunFixture);

const answers = { answers: { destination: ["Library"] } };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

async function withOwnRunQuestion(
  run: (fixture: Awaited<ReturnType<typeof createOwnRunFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createOwnRunFixture();
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}

describe("durable post-commit registration", () => {
  it.each([
    ["get", "definition"],
    ["list", "definition"],
    ["get", "timestamps"],
    ["list", "timestamps"],
  ] as const)(
    "rejects a same-binding recycled ID through %s when its %s changes",
    async (method, changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const f = await createOwnRunFixture(true);
        try {
          const registered = await f.call(
            "question.request",
            { ...requestParams, timeoutMs: 900_000, durable: true },
            f.runtime,
          );
          expect(registered[0], JSON.stringify(registered[2])).toBe(true);
          const id = (registered[1] as { id: string }).id;
          const observation = manager.observe(id)!;
          const scope = { ...sessionScope, assertCurrent() {} };
          const original = await questionStorage.executeSessionQuestionOperation(scope, {
            kind: "get",
            id,
          });
          if (!original || Array.isArray(original)) {
            throw new Error("Expected original canonical custody");
          }
          const capturedScope = { ...scope, storePath: original.sessionBinding.storePath };
          await questionStorage.executeSessionQuestionOperation(capturedScope, {
            kind: "settle",
            id,
            expectedQuestion: original,
            outcome: { id, status: "cancelled" },
            resolutionId: "original-terminal",
          });
          await questionStorage.executeSessionQuestionOperation(capturedScope, {
            kind: "block",
            id,
            expectedQuestion: original,
            reason: "Original native continuation is terminal",
          });
          await closeOpenClawAgentDatabaseByPathAsync(original.sessionBinding.databasePath);
          const terminal = new DatabaseSync(original.sessionBinding.databasePath);
          try {
            // Advance only this canonical fixture's retention deadline. The native
            // registration transaction below owns pruning and reusing its ID.
            terminal
              .prepare("UPDATE session_questions SET terminal_at = ? WHERE question_id = ?")
              .run(Date.now() - 24 * 60 * 60 * 1000 - 1, id);
          } finally {
            terminal.close();
          }
          expect(observation.isCurrent()).toBe(true);
          const successor = structuredClone(original);
          if (changed === "definition") {
            successor.record.questions[0]!.question = "Successor-only question";
          } else {
            successor.record.createdAtMs += 1;
            successor.record.expiresAtMs += 1;
          }
          expect(successor.sessionBinding).toEqual(original.sessionBinding);
          expect(
            await questionStorage.executeSessionQuestionOperation(capturedScope, {
              kind: "register",
              question: successor,
            }),
          ).toEqual(successor);
          await questionStorage.executeSessionQuestionOperation(capturedScope, {
            kind: "settle",
            id,
            expectedQuestion: successor,
            outcome: {
              id,
              status: "answered",
              answers: { answers: { destination: ["Successor"] } },
            },
            resolutionId: "successor-answer",
          });
          expect(observation.isCurrent()).toBe(true);
          const broad = { cfg: f.cfg, client: adminRequestClient };
          const result = await callQuestionRpc(
            method === "get" ? "question.get" : "question.list",
            method === "get" ? { id, includeContinuation: true } : { includeContinuation: true },
            broad,
          );
          if (method === "get") {
            expect(result).toMatchObject([
              false,
              undefined,
              { details: { reason: "QUESTION_NOT_FOUND" } },
            ]);
          } else {
            expect(result[0]).toBe(true);
            expect(result[1]).toMatchObject({ questions: [] });
          }
          expect(observation.isCurrent()).toBe(false);
          expect(
            await questionStorage.executeSessionQuestionOperation(capturedScope, {
              kind: "get",
              id,
            }),
          ).toMatchObject({
            record: {
              ...successor.record,
              status: "answered",
              answers: { answers: { destination: ["Successor"] } },
            },
            resolutionId: "successor-answer",
          });
        } finally {
          await f.close();
        }
      });
    },
  );

  it("retains committed custody when the original caller retires before publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const register = questionRegistration.registerDurableQuestion;
      let committedId: string | undefined;
      const spy = vi
        .spyOn(questionRegistration, "registerDurableQuestion")
        .mockImplementation(async (params) => {
          const committed = await register(params);
          committedId = committed.record.id;
          f.revokeSource();
          return committed;
        });
      try {
        expect(f.source.authority.recoverySnapshot).toBeDefined();
        await expect(
          f.call(
            "question.request",
            { ...requestParams, timeoutMs: 900_000, durable: true },
            f.runtime,
          ),
        ).rejects.toThrow("Original question source revoked");
        expect(committedId).toBeDefined();
        expect(manager.hasDurableCustody(committedId!)).toBe(true);
        expect(manager.get(committedId!)).toMatchObject({ status: "pending" });
        const retained = manager.get(committedId!)!;
        expect(retained.expiresAtMs - retained.createdAtMs).toBe(900_000);
        expect(broadcast.mock.calls.some(([event]) => event === "question.requested")).toBe(false);
      } finally {
        spy.mockRestore();
        await f.close();
      }
    });
  });

  it("repairs committed registration after a lost ACK and producer revocation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const operate = questionStorage.executeSessionQuestionOperation;
      let committedId: string | undefined;
      const spy = vi
        .spyOn(questionStorage, "executeSessionQuestionOperation")
        .mockImplementation(async (scope, operation) => {
          const result = await operate(scope, operation);
          if (operation.kind === "register") {
            committedId = operation.question.record.id;
            f.revokeSource();
            throw new SqliteWorkerError(
              "Registration ACK lost after source retirement",
              "outcome-unknown",
            );
          }
          return result;
        });
      try {
        await expect(
          f.call(
            "question.request",
            { ...requestParams, timeoutMs: 900_000, durable: true },
            f.runtime,
          ),
        ).rejects.toThrow("Original question source revoked");
        expect(committedId).toBeDefined();
        expect(manager.hasDurableCustody(committedId!)).toBe(true);
        expect(manager.get(committedId!)).toMatchObject({ status: "pending" });
        const retained = manager.get(committedId!)!;
        expect(retained.expiresAtMs - retained.createdAtMs).toBe(900_000);
        expect(broadcast.mock.calls.some(([event]) => event === "question.requested")).toBe(false);
      } finally {
        spy.mockRestore();
        await f.close();
      }
    });
  });

  it("adopts an unknown committed answer without acknowledging a revoked responder", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      let responderCurrent = true;
      const operate = questionStorage.executeSessionQuestionOperation;
      let restore = () => {};
      try {
        const registered = await f.call(
          "question.request",
          { ...requestParams, timeoutMs: 900_000, durable: true },
          f.runtime,
        );
        expect(registered[0], JSON.stringify(registered[2])).toBe(true);
        expect(registered[1]).toMatchObject({ durable: true });
        const id = (registered[1] as { id: string }).id;
        const spy = vi
          .spyOn(questionStorage, "executeSessionQuestionOperation")
          .mockImplementation(async (scope, operation) => {
            const result = await operate(scope, operation);
            if (operation.kind === "settle") {
              responderCurrent = false;
              throw new SqliteWorkerError(
                "Answer ACK lost after responder retirement",
                "outcome-unknown",
              );
            }
            return result;
          });
        restore = () => spy.mockRestore();
        await expect(
          callQuestionRpc(
            "question.resolve",
            { id, answers, resolutionId: "lost-answer-ack" },
            {
              cfg: f.cfg,
              client: f.browser.client,
              registered: true,
              hasCurrentClientAuthority: () => responderCurrent,
            },
          ),
        ).rejects.toThrow("Gateway requester authority changed");
        expect(manager.get(id)).toMatchObject({ status: "answered", answers });
        expect(await manager.waitAnswer(id, undefined, true)).toEqual({
          status: "answered",
          answers,
          resolutionId: "lost-answer-ack",
        });
      } finally {
        restore();
        await f.close();
      }
    });
  });

  it("rejects a terminal ID without reopening channel delivery or publishing a prompt", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const requested = vi.spyOn(questionChannel, "handleQuestionChannelRequested");
      const params = {
        ...requestParams,
        id: "terminal-registration-retry",
        timeoutMs: 900_000,
        durable: true,
      };
      try {
        const registered = await f.call("question.request", params, f.runtime);
        expect(registered[1]).toMatchObject({ durable: true, status: "pending" });
        const resolved = await f.call("question.resolve", { id: params.id, answers });
        expect(resolved[1]).toEqual({ status: "answered", answers });
        requested.mockClear();
        broadcast.mockClear();
        const retry = await f.call("question.request", params, f.runtime);
        expect(retry[0]).toBe(false);
        expect(manager.get(params.id)).toMatchObject({ status: "answered", answers });
        expect(requested).not.toHaveBeenCalled();
        expect(broadcast.mock.calls.some(([event]) => event === "question.requested")).toBe(false);
      } finally {
        requested.mockRestore();
        await f.close();
      }
    });
  });

  it.each(["get", "list", "get-after-read", "list-after-read", "resolve"] as const)(
    "refuses a same-ID successor database fact when %s reads a broadly authorized old observation first",
    async (firstRead) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const f = await createOwnRunFixture(true);
        let restoreRead: (() => void) | undefined;
        try {
          const registered = await f.call(
            "question.request",
            { ...requestParams, timeoutMs: 900_000, durable: true },
            f.runtime,
          );
          const id = (registered[1] as { id: string }).id;
          const scope = { ...sessionScope, assertCurrent() {} };
          const original = await questionStorage.executeSessionQuestionOperation(scope, {
            kind: "get",
            id,
          });
          if (!original || Array.isArray(original)) {
            throw new Error("Expected original durable fact");
          }
          const broad = { cfg: f.cfg, client: adminRequestClient };
          expect((await callQuestionRpc("question.get", { id }, broad))[0]).toBe(true);
          expect(
            (await callQuestionRpc("question.list", { includeContinuation: true }, broad))[1],
          ).toMatchObject({ questions: [{ id }] });
          const replacementScope = { ...scope, storePath: state.statePath("successor.sqlite") };
          await upsertSessionEntryCore(replacementScope, f.entry);
          const target = await prepareSqliteScope(replacementScope);
          if (!target.path) {
            throw new Error("Expected successor database path");
          }
          const successorPath = target.path;
          const identity = readDatabasePathIdentitySync(successorPath);
          const successor = {
            ...original,
            record: { ...original.record, runId: "successor-asking" },
            provenance: {
              ...original.provenance,
              sourceRunId: "successor-asking",
              ...(original.provenance.recoverySource
                ? {
                    recoverySource: {
                      ...original.provenance.recoverySource,
                      sourceRunId: "successor-asking",
                    },
                  }
                : {}),
            },
            sessionBinding: {
              ...original.sessionBinding,
              storePath: replacementScope.storePath,
              databasePath: successorPath,
              databaseIdentity: {
                identity: identity.key.slice("file:".length),
                birthtime: identity.birthtime,
              },
            },
          };
          await questionStorage.executeSessionQuestionOperation(replacementScope, {
            kind: "register",
            question: successor,
          });
          await questionStorage.executeSessionQuestionOperation(replacementScope, {
            kind: "settle",
            expectedQuestion: successor,
            id,
            outcome: {
              id,
              status: "answered",
              answers: { answers: { destination: ["Successor"] } },
            },
            resolutionId: "successor-answer",
          });
          if (firstRead === "resolve") {
            expect((await f.call("question.resolve", { id, answers }, f.runtime))[0]).toBe(true);
          }
          await closeOpenClawAgentDatabaseByPathAsync(successorPath);
          await closeOpenClawAgentDatabaseByPathAsync(original.sessionBinding.databasePath);
          const replaceDatabase = () => {
            fs.renameSync(
              original.sessionBinding.databasePath,
              state.statePath("original-question.sqlite"),
            );
            fs.copyFileSync(successorPath, original.sessionBinding.databasePath);
          };
          if (firstRead.endsWith("after-read")) {
            const read = questionStorage.readSessionQuestionCustody;
            const readSpy = vi
              .spyOn(questionStorage, "readSessionQuestionCustody")
              .mockImplementation(async (...args) => {
                const result = await read(...args);
                if (args[1] === id) {
                  replaceDatabase();
                  restoreRead?.();
                }
                return result;
              });
            restoreRead = () => readSpy.mockRestore();
          } else {
            replaceDatabase();
          }
          const healthy = manager.request({
            id: "healthy-unbound-question",
            questions: requestParams.questions,
            timeoutMs: 900_000,
          });
          if (firstRead.startsWith("get")) {
            expect(
              await callQuestionRpc("question.get", { id, includeContinuation: true }, broad),
            ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
          }
          if (firstRead === "resolve") {
            expect(await callQuestionRpc("question.resolve", { id, answers }, broad)).toMatchObject(
              [false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }],
            );
          }
          const listed = await callQuestionRpc(
            "question.list",
            { includeContinuation: true },
            broad,
          );
          expect(listed[0]).toBe(true);
          expect(listed[1]).toEqual({ questions: [healthy], continuations: [] });
          expect(
            await callQuestionRpc("question.get", { id, includeContinuation: true }, broad),
          ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
          expect(manager.observe(id)).toBeNull();
          expect(manager.observe(healthy.id)?.isCurrent()).toBe(true);
        } finally {
          restoreRead?.();
          await f.close();
        }
      });
    },
  );

  it("reconciles an unknown registration ACK using the same canonical JSON definition", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = await createOwnRunFixture(true);
      const operate = questionStorage.executeSessionQuestionOperation;
      let lost = false;
      const spy = vi
        .spyOn(questionStorage, "executeSessionQuestionOperation")
        .mockImplementation(async (scope, operation) => {
          const result = await operate(scope, operation);
          if (operation.kind === "register" && !lost) {
            lost = true;
            throw new SqliteWorkerError("Registration ACK lost after commit", "outcome-unknown");
          }
          return result;
        });
      try {
        const response = await f.call(
          "question.request",
          { ...requestParams, timeoutMs: 900_000, durable: true },
          f.runtime,
        );
        expect(response[0], JSON.stringify(response[2])).toBe(true);
        expect(response[1]).toMatchObject({ durable: true });
        expect(lost).toBe(true);
        expect(manager.hasDurableCustody((response[1] as { id: string }).id)).toBe(true);
      } finally {
        spy.mockRestore();
        await f.close();
      }
    });
  });
});

describe("own-run question admission", () => {
  it("keeps transient native questions readable despite having a durable session binding", async () => {
    await withOwnRunQuestion(async (f) => {
      const id = await f.request();
      expect(manager.observe(id)?.sessionAccess?.durableBinding).toBeDefined();
      expect(manager.hasDurableCustody(id)).toBe(false);
      expect((await f.call("question.get", { id }))[1]).toMatchObject({ question: { id } });
      expect((await f.call("question.list", {}))[1]).toMatchObject({ questions: [{ id }] });
    });
  });

  it.each(["suspension", "restart drain"] as const)(
    "keeps foreign question IDs outside retained roots during %s",
    async (mode) => {
      try {
        await withOwnRunQuestion(async (f) => {
          const id = await f.request();
          const foreign = createQuestionTestPeer(
            ensureProfileForEmail("foreign-drain@example.test"),
            "foreign",
          );
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          const read = vi.spyOn(manager, "get");
          const suspension =
            mode === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : undefined;
          if (mode === "suspension") {
            expect(suspension?.drain()).toBe(true);
          } else {
            markGatewayRestartDraining();
          }
          try {
            for (const method of ["question.get", "question.resolve"]) {
              expect(
                await f.call(
                  method,
                  { id, ...(method === "question.resolve" ? { answers } : {}) },
                  foreign.client,
                ),
              ).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
              await expect(
                callQuestionRpc(
                  method,
                  { id, ...(method === "question.resolve" ? { answers } : {}) },
                  {
                    cfg: f.cfg,
                    client: f.browser.client,
                    registered: true,
                    hasCurrentClientAuthority: () => false,
                  },
                ),
              ).rejects.toThrow("Gateway requester authority changed");
            }
            expect(
              read,
              "foreign or revoked requests must be rejected before liveness is read",
            ).not.toHaveBeenCalled();
            expect(getActiveGatewayRootWorkCount()).toBe(1);

            expect(await f.call("question.get", { id })).toMatchObject([
              true,
              { question: { id, status: "pending" } },
              undefined,
            ]);
            expect(await f.call("question.resolve", { id, answers })).toEqual([
              true,
              { status: "answered", answers },
              undefined,
            ]);
            await manager.drain();
            expect(getActiveGatewayRootWorkCount()).toBe(0);
          } finally {
            read.mockRestore();
            suspension?.release();
          }
        });
      } finally {
        resetGatewayWorkAdmission();
      }
    },
  );

  it("recovers an ordinary question after reconnect and retains an accepted answer after run close", async () => {
    await withOwnRunQuestion(async (f) => {
      const id = await f.request();
      expect(f.browser.socket.send).toHaveBeenCalledOnce();
      expect(JSON.parse(String(f.browser.socket.send.mock.calls[0]![0]))).toMatchObject({
        event: "question.requested",
        payload: { id },
      });
      f.clients.delete(f.browser.client);
      const reconnected = createQuestionTestPeer(f.profile, "reconnected-browser");
      f.clients.add(reconnected.client);
      expect((await f.call("question.list", {}, reconnected.client))[1]).toMatchObject({
        questions: [{ id }],
      });
      expect((await f.call("question.get", { id }, reconnected.client))[1]).toMatchObject({
        question: { id, status: "pending" },
      });
      const waiting = await f.beginWait(id, reconnected.client);
      broadcast.mockImplementation((event, payload, opts) => {
        f.broadcaster.broadcast(event, payload, opts);
        if (event === "question.resolved") {
          releaseAgentRunDelegatedAuthority(f.authority);
          f.source.release();
        }
      });
      const accepted = { status: "answered", answers };
      expect((await f.call("question.resolve", { id, answers }, reconnected.client))[1]).toEqual(
        accepted,
      );
      expect((await waiting.result)[1]).toEqual(accepted);
      expect((await f.call("question.waitAnswer", { id }, reconnected.client))[1]).toEqual(
        accepted,
      );
      expect((await f.call("question.get", { id }, reconnected.client))[1]).toMatchObject({
        question: { id, ...accepted },
      });
      await manager.drain();
      expect(reconnected.socket.send).toHaveBeenCalledOnce();
      expect(JSON.parse(String(reconnected.socket.send.mock.calls[0]![0]))).toMatchObject({
        event: "question.resolved",
        payload: { id, ...accepted },
      });
      for (const [method, scope] of [
        ["exec.approval.resolve", "operator.approvals"],
        ["secrets.store.set", "operator.admin"],
      ] as const) {
        expect(await f.call(method, {}, reconnected.client)).toMatchObject([
          false,
          undefined,
          { code: "FORBIDDEN", message: "missing scope: " + scope },
        ]);
      }
    });
  });

  it("conceals questions from foreign viewers and members with session read and write scopes", async () => {
    await withOwnRunQuestion(async (f) => {
      const peers = ["viewer", "member"].map((name) =>
        createQuestionTestPeer(ensureProfileForEmail(name + "@example.test"), name, [
          "operator.sessions.write",
          "operator.sessions.read",
        ]),
      );
      await addSessionMember(sessionScope, {
        identityId: peers[1]!.client.authenticatedUserProfile!.profileId,
        addedBy: f.profile.id,
        expectedSessionId: f.entry.sessionId,
      });
      for (const peer of peers) {
        f.clients.add(peer.client);
        expect(
          await canReceivePreparedSessionEvent({
            cfg: f.cfg,
            client: peer.client,
            sessionKeys: [requestParams.sessionKey],
          }),
        ).toBe(true);
      }
      const id = await f.request();
      const binding = manager.observe(id)!.sessionAccess!;
      let retainedReads = 0;
      const assertSourceCurrent = binding.assertSourceCurrent;
      vi.spyOn(binding, "assertSourceCurrent").mockImplementation(() => {
        retainedReads += 1;
        assertSourceCurrent();
      });
      const assertCurrent = binding.assertCurrent;
      vi.spyOn(binding, "assertCurrent").mockImplementation((read) => {
        retainedReads += 1;
        assertCurrent(read);
      });
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      vi.spyOn(projectionLane.pool, "run").mockImplementation((...args) => {
        retainedReads += 1;
        return run(...args);
      });
      const requestedEvent = broadcast.mock.calls[0];
      if (!requestedEvent || requestedEvent[0] !== "question.requested") {
        throw new Error("expected the registered question event");
      }
      f.clients.delete(f.browser.client);
      retainedReads = 0;
      f.broadcaster.broadcast(...requestedEvent);
      expect(
        retainedReads,
        "foreign recipients must not probe the retained session's filesystem identity",
      ).toBe(0);
      f.clients.add(f.browser.client);
      const unrelated = claimAgentRunDelegatedAuthority({
        instanceId: "unrelated-run",
        runId: "unrelated-run",
      });
      retainedReads = 0;
      releaseAgentRunDelegatedAuthority(unrelated);
      expect(retainedReads, "closing an unrelated run must not probe the question's session").toBe(
        0,
      );
      retainedReads = 0;
      manager.cancelClosedAuthorities({ instanceId: "older-instance", runId: requestParams.runId });
      expect(retainedReads, "reused run IDs must retain their exact operational instance").toBe(0);
      manager.cancelClosedAuthorities({ runId: "unrelated-worker-run" });
      expect(retainedReads, "an unrelated worker run must not probe the question's session").toBe(
        0,
      );
      for (const peer of peers) {
        retainedReads = 0;
        expect((await f.call("question.list", {}, peer.client))[1]).toEqual({ questions: [] });
        expect(retainedReads, "a foreign question list must not inspect the retained session").toBe(
          0,
        );
        for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
          retainedReads = 0;
          expect(
            await f.call(
              method,
              { id, ...(method === "question.resolve" ? { answers } : {}) },
              peer.client,
            ),
          ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
          expect(retainedReads, "foreign keyed reads must not probe the retained session").toBe(0);
        }
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
      expect(await f.call("question.resolve", { id, answers })).toEqual([
        true,
        { status: "answered", answers },
        undefined,
      ]);
      for (const peer of peers) {
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
      await manager.drain();
      expect(f.browser.socket.send).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects forged admission and keeps unbound, sessionless, and secret records privileged", async () => {
    await withOwnRunQuestion(async (f) => {
      const unboundRuntime: GatewayClient = {
        ...f.runtime,
        internal: { agentRuntimeIdentity: f.runtime.internal?.agentRuntimeIdentity },
      };
      for (const [params, client] of [
        [requestParams, f.browser.client],
        [{ questions: requestParams.questions }, f.browser.client],
        [requestParams, unboundRuntime],
        [secretRequestParams, f.runtime],
        [
          { ...requestParams, questions: [{ ...requestParams.questions[0]!, isSecret: true }] },
          f.runtime,
        ],
      ] as const) {
        expect((await f.call("question.request", params, client))[0]).toBe(false);
      }
      expect(manager.list()).toEqual([]);
      const protectedRecords = [
        manager.request({ ...requestParams, id: "administrative-question" }),
        manager.request({
          id: "sessionless-question",
          questions: requestParams.questions,
          timeoutMs: 100,
        }),
        manager.request({
          ...requestParams,
          id: "secret-question",
          questions: [secretRequestQuestion],
        }),
      ];
      expect((await f.call("question.list", {}))[1]).toEqual({ questions: [] });
      for (const record of protectedRecords) {
        f.broadcaster.broadcast("question.requested", record);
        for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
          expect(
            await f.call(method, {
              id: record.id,
              ...(method === "question.resolve" ? { cancel: true } : {}),
            }),
          ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
        }
        expect(manager.get(record.id)?.status).toBe("pending");
      }
      expect(f.browser.socket.send).not.toHaveBeenCalled();
    });
  });

  it.each(["source revoked", "exact run closed"] as const)(
    "settles the original question when its %s",
    async (cause) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const waiting = await f.beginWait(id);
        if (cause === "source revoked") {
          setUserProfileRole(f.profile.id, "suspended");
          invalidateOperatorRolePolicy(f.profile.id);
          expect(f.source.authority.signal?.aborted).toBe(true);
        } else {
          releaseAgentRunDelegatedAuthority(f.authority);
        }
        const system = createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "system" },
          scopes: ["operator.questions"],
        });
        expect((await f.call("question.get", { id }, system))[1]).toMatchObject({
          question: { id, status: "cancelled" },
        });
        const response = await waiting.result;
        if (cause === "source revoked") {
          expect(response[0]).toBe(false);
        } else {
          expect(response).toEqual([true, { status: "cancelled" }, undefined]);
        }
        expect((await f.call("question.resolve", { id, answers }))[0]).toBe(false);
        expect(manager.get(id)).not.toHaveProperty("answers");
      });
    },
  );

  it.each(["source revocation", "transient worker failure"] as const)(
    "preserves the question's authority outcome across %s during a read",
    async (cause) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const observation = manager.observe(id)!;
        let settled = false;
        const waiting = manager.waitAnswer(id).then((result) => {
          settled = true;
          return result;
        });
        const recipient = createQuestionTestPeer(f.profile, "independent-current-recipient");
        const entered = createDeferred();
        const release = createDeferred();
        const failure = new Error("Transient question worker read failure");
        // The injected failure must exercise the worker instead of a warm entry receipt.
        sessionChanges.invalidate({
          ...sessionScope,
          storePath: resolveOpenClawAgentSqlitePath(sessionScope),
          factsInvalidated: true,
        });
        const run = projectionLane.pool.run.bind(projectionLane.pool);
        const spy = vi.spyOn(projectionLane.pool, "run").mockImplementationOnce(async (...args) => {
          if (cause === "transient worker failure") {
            throw failure;
          }
          const result = await run(...args);
          entered.resolve();
          await release.promise;
          return result;
        });
        const request = f.call(
          "question.get",
          { id },
          cause === "source revocation" ? recipient.client : f.browser.client,
        );
        const result = Promise.allSettled([request]);
        try {
          if (cause === "transient worker failure") {
            await expect(request).rejects.toThrow(failure);
            expect(observation.isCurrent()).toBe(true);
            expect(observation.record.status).toBe("pending");
            expect(settled).toBe(false);
          } else {
            await entered.promise;
            f.revokeSource();
            expect(f.source.authority.signal?.aborted).toBe(true);
            expect(recipient.client.invalidated).not.toBe(true);
            expect(observation.record.status).toBe("pending");
            release.resolve();
            expect(await request).toMatchObject([
              false,
              undefined,
              { details: { reason: "QUESTION_NOT_FOUND" } },
            ]);
            expect(observation.record.status).toBe("cancelled");
            expect(await waiting).toEqual({ status: "cancelled" });
            await manager.drain();
            expect(getActiveGatewayRootWorkCount()).toBe(0);
          }
        } finally {
          release.resolve();
          await result;
          spy.mockRestore();
          manager.close();
          await waiting;
          await manager.drain();
        }
      });
    },
  );

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "refuses the old binding after %s replacement under the same key",
    async (field) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const observation = manager.observe(id)!;
        const waiting = manager.waitAnswer(id);
        replaceSessionEntrySync(sessionScope, { ...f.entry, [field]: "replacement", updatedAt: 2 });
        expect(await f.call("question.get", { id })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
        // The first worker-confirmed denial retires the original entry without another get().
        expect(observation.record.status).toBe("cancelled");
        expect(await waiting).toEqual({ status: "cancelled" });
        await manager.drain();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        for (const method of ["question.waitAnswer", "question.resolve"]) {
          expect(
            await f.call(method, { id, ...(method === "question.resolve" ? { answers } : {}) }),
          ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
        }
        expect((await f.call("question.list", {}))[1]).toEqual({ questions: [] });
        expect(manager.get(id)?.status).toBe("cancelled");
        await manager.drain();
        expect(f.browser.socket.send).toHaveBeenCalledOnce();
      });
    },
  );

  it.each(["client invalidation", "request authority revocation"] as const)(
    "fences answer delivery after %s while retaining accepted truth",
    async (cause) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const observer: GatewayClient = { ...f.browser.client };
        let current = true;
        const waiting = await f.beginWait(id, observer, () => current);
        const rejected = expect(waiting.result).rejects.toThrow(
          "Gateway requester authority changed",
        );
        if (cause === "client invalidation") {
          observer.invalidated = true;
        } else {
          current = false;
        }
        expect((await f.call("question.resolve", { id, answers }))[0]).toBe(true);
        await rejected;
        expect((await f.call("question.get", { id }))[1]).toMatchObject({
          question: { id, status: "answered", answers },
        });
      });
    },
  );
});
