import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { sessionStoreLane } from "../../config/sessions/session-transcript-worker-resources.js";
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
import { prepareGatewayOperatorRunAuthority } from "../operator-run-authority.js";
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
  secretRequestQuestion,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const answers = { answers: { destination: ["Library"] } };
const sessionScope = { agentId: "main", sessionKey: requestParams.sessionKey };

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
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      role: "operator",
      scopes,
    },
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
  const captured = await prepareGatewayOperatorRunAuthority({
    client: browser.client,
    context: { getRuntimeConfig: () => cfg },
    sourceAuthority: {
      signal: sourceController.signal,
      assertCurrent: () => sourceController.signal.throwIfAborted(),
    },
  });
  if (!captured) {
    throw new Error("expected the Guest's admitted operator authority");
  }
  const source = captured;
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "guest-question-run",
    runId: requestParams.runId,
  });
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
  const beginWait = async (id: string, client: GatewayClient = browser.client) => {
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
      },
    );
    try {
      await Promise.race([
        attached.promise,
        result.then((response) => {
          throw new Error("question waiter was not admitted: " + JSON.stringify(response[2]));
        }),
      ]);
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
            }
            expect(
              read,
              "foreign requests must be rejected before liveness is read",
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
      const reconnected = questionPeer(f.profile, "reconnected-browser");
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
      const run = sessionStoreLane.pool.run.bind(sessionStoreLane.pool);
      vi.spyOn(sessionStoreLane.pool, "run").mockImplementation((...args) => {
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

  it("keeps an admitted question live after a role change and refuses the next producer", async () => {
    await withOwnRunQuestion(async (f) => {
      const id = await f.request();
      const observation = manager.observe(id)!;
      const waiting = manager.waitAnswer(id);
      setUserProfileRole(f.profile.id, "suspended");
      invalidateOperatorRolePolicy(f.profile.id);
      expect(f.source.authority.signal?.aborted).not.toBe(true);
      expect(observation.sessionAccess?.assertSourceCurrent).not.toThrow();
      expect(observation.record.status).toBe("pending");
      await expect(
        f.call("question.request", { ...requestParams, id: "refused-producer" }, f.runtime),
      ).resolves.toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
      expect(manager.observe("refused-producer")).toBeNull();
      const system = createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "system" },
        scopes: ["operator.questions"],
      });
      expect(await f.call("question.resolve", { id, answers }, system)).toEqual([
        true,
        { status: "answered", answers },
        undefined,
      ]);
      expect(await waiting).toEqual({ status: "answered", answers });
    });
  });

  it.each(["ordinary", "sessionless", "missing session", "secret"] as const)(
    "preserves admitted admin producer lifetime and checks the next start (%s)",
    async (kind) => {
      await withOwnRunQuestion(async (f) => {
        f.cfg.gateway!.roles!.definitions.admin = {
          scopes: ["operator.admin"],
          agents: "*",
          sessions: { others: "write" },
        };
        setUserProfileRole(f.profile.id, "admin");
        const client = {
          ...f.browser.client,
          connect: { ...f.browser.client.connect, scopes: ["operator.admin"] },
        };
        const admitted = await prepareGatewayOperatorRunAuthority({
          client,
          context: { getRuntimeConfig: () => f.cfg },
        });
        if (!admitted) {
          throw new Error("Expected admitted admin source");
        }
        const producer: GatewayClient = {
          ...client,
          internal: {
            operatorRunAuthority: admitted.authority,
            ...(kind === "secret"
              ? { agentRuntimeIdentity: f.runtime.internal!.agentRuntimeIdentity }
              : {}),
          },
        };
        const params = {
          ...(kind === "secret" ? secretRequestParams : requestParams),
          ...(kind === "sessionless"
            ? { sessionKey: undefined, agentId: undefined, runId: undefined }
            : kind === "missing session"
              ? { sessionKey: "agent:main:missing" }
              : {}),
        };
        try {
          const response = await f.call("question.request", params, producer);
          expect(response[0], JSON.stringify(response[2])).toBe(true);
          const id = (response[1] as { id: string }).id;
          const observation = manager.observe(id)!;
          setUserProfileRole(f.profile.id, "suspended");
          invalidateOperatorRolePolicy(f.profile.id);
          expect(observation.record.status).toBe("pending");
          expect(admitted.authority.signal?.aborted).not.toBe(true);
          // Neither optional-session fallback nor a secret prompt can skip new admission.
          const next = f.call("question.request", { ...params, id: "refused-producer" }, producer);
          await expect(next).resolves.toMatchObject([false, undefined, { code: "FORBIDDEN" }]);
          expect(manager.observe("refused-producer")).toBeNull();
        } finally {
          admitted.release();
        }
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
        // Background membership refresh shares this lane; fault only the question's row read.
        const run = sessionStoreLane.pool.run.bind(sessionStoreLane.pool);
        let injected = false;
        const spy = vi.spyOn(sessionStoreLane.pool, "run").mockImplementation(async (...args) => {
          let selected = false;
          const result = await run(async () => {
            const input = typeof args[0] === "function" ? await args[0]() : args[0];
            if (
              !injected &&
              input.kind === "session-exact-entries" &&
              input.sessionKeys?.includes(sessionScope.sessionKey)
            ) {
              injected = true;
              selected = true;
              if (cause === "transient worker failure") {
                throw failure;
              }
            }
            return input;
          }, args[1]);
          if (selected) {
            entered.resolve();
            await release.promise;
          }
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
            expect(f.source.authority.signal?.aborted).not.toBe(true);
            expect(recipient.client.invalidated).not.toBe(true);
            expect(observation.record.status).toBe("pending");
            release.resolve();
            expect(await request).toMatchObject([
              true,
              { question: { id, status: "pending" } },
              undefined,
            ]);
            expect(settled).toBe(false);
            expect(await f.call("question.resolve", { id, answers })).toEqual([
              true,
              { status: "answered", answers },
              undefined,
            ]);
            expect(await waiting).toEqual({ status: "answered", answers });
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
});
