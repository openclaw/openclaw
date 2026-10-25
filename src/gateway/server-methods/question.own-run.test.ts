import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import {
  canReceivePreparedSessionEvent,
  createProjectedSessionEventPredicate,
} from "../session-sharing.test-utils.js";
import {
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
  requestParams,
  secretRequestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const answers = { answers: { destination: ["Library"] } };
const answered = { status: "answered", answers };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

function expectHidden(response: Awaited<ReturnType<typeof callQuestionRpc>>) {
  expect(response).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
}

function expectAnswered(response: Awaited<ReturnType<typeof callQuestionRpc>>) {
  expect(response).toEqual([true, answered, undefined]);
}

function questionPeer(
  profile: ReturnType<typeof ensureProfileForEmail>,
  connId: string,
  scopes = ["operator.sessions.write"],
) {
  const socket = {
    bufferedAmount: 0,
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(
      (
        _wire: string | Buffer,
        options?: { binary: false } | ((error?: Error) => void),
        callback?: (error?: Error) => void,
      ) => (typeof options === "function" ? options : callback)?.(),
    ),
  };
  const client: GatewayWsClient = {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: { role: "operator", scopes } as GatewayWsClient["connect"],
    connId,
    usesSharedGatewayAuth: false,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      avatarRevision: "",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  };
  prepareGatewayRecipientProfile(client);
  return { client, socket };
}

async function createOwnRunFixture() {
  const profile = ensureProfileForEmail("guest@example.test");
  const cfg: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: "*",
            scopes: ["operator.sessions.write", "operator.sessions.read"],
          },
          suspended: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  };
  const entry: SessionEntry = {
    sessionId: "guest-question-session",
    lifecycleRevision: "guest-question-generation",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: profile.id },
  };
  setRuntimeConfigSnapshot(cfg);
  await upsertSessionEntryCore(sessionScope, entry);
  const browser = questionPeer(profile, "original-browser");
  const sourceController = new AbortController();
  const source = await captureGatewayOperatorRunAuthority({
    client: browser.client,
    context: { getRuntimeConfig: () => cfg },
    sourceAuthority: {
      signal: sourceController.signal,
      assertCurrent: () => sourceController.signal.throwIfAborted(),
    },
  });
  if (!source) {
    throw new Error("expected the Guest's admitted operator authority");
  }
  const authority = claimAgentRunDelegatedAuthority(
    { instanceId: "guest-question-run", runId: requestParams.runId },
    source.authority.assertCurrent,
  );
  const synthetic = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: profile.id },
    operatorRunAuthority: source.authority,
    scopes: ["operator.sessions.write"],
  });
  const runtime: GatewayClient = {
    ...synthetic,
    internal: {
      ...synthetic.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: requestParams.agentId,
        sessionKey: requestParams.sessionKey,
        operationalRunInstance: authority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      },
    },
  };
  const projection = await createSessionRowProjection({ cfg });
  await projection.ensureMaterialized();
  const clients = new GatewayClientRegistry([browser.client]);
  const broadcaster = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: createProjectedSessionEventPredicate(cfg, projection),
  });
  broadcast.mockImplementation(broadcaster.broadcast);
  const call = (
    method: string,
    params: Record<string, unknown>,
    client: GatewayClient = browser.client,
  ) => callQuestionRpc(method, params, { cfg, client, registered: true });
  const request = async () => {
    const response = await call("question.request", requestParams, runtime);
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    return (response[1] as { id: string }).id;
  };
  const beginWait = async (
    id: string,
    client: GatewayClient = browser.client,
    hasCurrentClientAuthority?: () => boolean,
  ) => {
    const attached = createDeferred();
    const waitAnswer = manager.waitAnswer.bind(manager);
    const observer = vi.spyOn(manager, "waitAnswer").mockImplementationOnce((...args) => {
      const result = waitAnswer(...args);
      attached.resolve();
      return result;
    });
    const result = callQuestionRpc(
      "question.waitAnswer",
      { id },
      {
        cfg,
        client,
        registered: true,
        hasCurrentClientAuthority,
      },
    );
    try {
      await awaitGateBeforeSettlement(attached.promise, result, "question waiter was not admitted");
    } finally {
      observer.mockRestore();
    }
    return { result };
  };
  return {
    profile,
    cfg,
    entry,
    browser,
    runtime,
    clients,
    broadcaster,
    authority,
    source,
    revokeSource: () => sourceController.abort(new Error("Original question source revoked")),
    call,
    request,
    beginWait,
    close: async () => {
      try {
        manager.reset();
        await manager.drain();
        releaseAgentRunDelegatedAuthority(authority);
        source.release();
      } finally {
        projection.dispose();
      }
    },
  };
}

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

describe("own-run question admission", () => {
  it.each(["suspension", "restart drain"] as const)(
    "keeps foreign question IDs outside retained roots during %s",
    async (mode) => {
      try {
        await withOwnRunQuestion(async (f) => {
          const id = await f.request();
          const foreign = questionPeer(
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
            expectAnswered(await f.call("question.resolve", { id, answers }));
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

  it("conceals questions from foreign viewers and members with session read and write scopes", async () => {
    await withOwnRunQuestion(async (f) => {
      const peers = ["viewer", "member"].map((name) =>
        questionPeer(ensureProfileForEmail(name + "@example.test"), name, [
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
      const retainedReads = [
        vi.spyOn(binding, "assertSourceCurrent"),
        vi.spyOn(binding, "assertCurrent"),
        vi.spyOn(projectionLane.pool, "run"),
      ];
      const requestedEvent = broadcast.mock.calls[0];
      if (!requestedEvent || requestedEvent[0] !== "question.requested") {
        throw new Error("expected the registered question event");
      }
      f.clients.delete(f.browser.client);
      f.broadcaster.broadcast(...requestedEvent);
      f.clients.add(f.browser.client);
      const unrelated = claimAgentRunDelegatedAuthority({
        instanceId: "unrelated-run",
        runId: "unrelated-run",
      });
      releaseAgentRunDelegatedAuthority(unrelated);
      manager.cancelClosedAuthorities({ instanceId: "older-instance", runId: requestParams.runId });
      manager.cancelClosedAuthorities({ runId: "unrelated-worker-run" });
      for (const peer of peers) {
        expect((await f.call("question.list", {}, peer.client))[1]).toEqual({ questions: [] });
        for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
          expectHidden(
            await f.call(
              method,
              { id, ...(method === "question.resolve" ? { answers } : {}) },
              peer.client,
            ),
          );
        }
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
      // None of the foreign reads, deliveries or unrelated run closures may probe this session.
      for (const read of retainedReads) {
        expect(read).not.toHaveBeenCalled();
      }
      expectAnswered(await f.call("question.resolve", { id, answers }));
      for (const peer of peers) {
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
      await manager.drain();
      expect(f.browser.socket.send).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects forged admission and conceals unbound questions", async () => {
    await withOwnRunQuestion(async (f) => {
      for (const [method, scope] of [
        ["exec.approval.resolve", "operator.approvals"],
        ["secrets.store.set", "operator.admin"],
      ] as const) {
        expect(await f.call(method, {}, f.browser.client)).toMatchObject([
          false,
          undefined,
          { code: "FORBIDDEN", message: "missing scope: " + scope },
        ]);
      }
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
      // Missing session access is one branch; real privileged ordinary/secret flows
      // are covered by question.session-access's narrow-reader concealment cases.
      const record = manager.request({
        id: "sessionless-question",
        questions: requestParams.questions,
        timeoutMs: 100,
      });
      expect((await f.call("question.list", {}))[1]).toEqual({ questions: [] });
      f.broadcaster.broadcast("question.requested", record);
      for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
        expectHidden(
          await f.call(method, {
            id: record.id,
            ...(method === "question.resolve" ? { cancel: true } : {}),
          }),
        );
      }
      expect(manager.get(record.id)?.status).toBe("pending");
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
        const recipient = questionPeer(f.profile, "independent-current-recipient");
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
            expectHidden(await request);
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
        expectHidden(await f.call("question.get", { id }));
        // The first worker-confirmed denial retires the original entry without another get().
        expect(observation.record.status).toBe("cancelled");
        expect(await waiting).toEqual({ status: "cancelled" });
        await manager.drain();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        for (const method of ["question.waitAnswer", "question.resolve"]) {
          expectHidden(
            await f.call(method, { id, ...(method === "question.resolve" ? { answers } : {}) }),
          );
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
