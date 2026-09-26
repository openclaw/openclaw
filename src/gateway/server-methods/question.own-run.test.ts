import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
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
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import * as sessionSharingPreparation from "../session-sharing-preparation.js";
import { canReceiveSessionEvent } from "../session-sharing.js";
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
    send: vi.fn((_wire: string, callback?: (error?: Error) => void) => callback?.()),
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
  await upsertSessionEntryCore(sessionScope, entry);
  const browser = questionPeer(profile, "original-browser");
  const source = captureGatewayOperatorRunAuthority({
    client: browser.client,
    context: { getRuntimeConfig: () => cfg },
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
  const clients = new GatewayClientRegistry([browser.client]);
  const broadcaster = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({ cfg, client, sessionKeys, agentId, event, payload }),
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
    call,
    request,
    beginWait,
    close: () => {
      manager.reset();
      releaseAgentRunDelegatedAuthority(authority);
      source.release();
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
      fixture.close();
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
            expect(await f.call("question.resolve", { id, answers })).toEqual([
              true,
              { status: "answered", answers },
              undefined,
            ]);
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
      expect(JSON.parse(f.browser.socket.send.mock.calls[0]![0])).toMatchObject({
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
      expect(reconnected.socket.send).toHaveBeenCalledOnce();
      expect(JSON.parse(reconnected.socket.send.mock.calls[0]![0])).toMatchObject({
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
      const prepare = sessionSharingPreparation.prepareSessionMutationFacts;
      let retainedReads = 0;
      vi.spyOn(sessionSharingPreparation, "prepareSessionMutationFacts").mockImplementation(
        async (params) => {
          const prepared = await prepare(params);
          return {
            release: prepared.release,
            readCurrent: (cfg) => {
              retainedReads += 1;
              return prepared.readCurrent(cfg);
            },
          };
        },
      );
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
          canReceiveSessionEvent({
            cfg: f.cfg,
            client: peer.client,
            sessionKeys: [requestParams.sessionKey],
          }),
        ).toBe(true);
      }
      const id = await f.request();
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

  it.each(["sessionId", "lifecycleRevision"] as const)(
    "refuses the old binding after %s replacement under the same key",
    async (field) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        replaceSessionEntrySync(sessionScope, { ...f.entry, [field]: "replacement", updatedAt: 2 });
        for (const method of ["question.get", "question.waitAnswer", "question.resolve"]) {
          expect(
            await f.call(method, { id, ...(method === "question.resolve" ? { answers } : {}) }),
          ).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
        }
        expect((await f.call("question.list", {}))[1]).toEqual({ questions: [] });
        expect(manager.get(id)?.status).toBe("cancelled");
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

  it.each(["answer", "cancel"] as const)(
    "refuses to %s from a revoked request while the original question remains active",
    async (action) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const observer = { ...f.browser.client, connId: "revoked-observer" };
        await expect(
          callQuestionRpc(
            "question.resolve",
            {
              id,
              ...(action === "answer" ? { answers } : { cancel: true }),
            },
            {
              cfg: f.cfg,
              client: observer,
              registered: true,
              hasCurrentClientAuthority: () => false,
            },
          ),
        ).rejects.toThrow("Gateway requester authority changed");
        expect(manager.get(id)?.status).toBe("pending");
      });
    },
  );

  it.each(["question.get", "question.list", "question.waitAnswer"] as const)(
    "fences a revoked %s before reading the question owner",
    async (method) => {
      await withOwnRunQuestion(async (f) => {
        const id = await f.request();
        const read = vi.spyOn(manager, "get").mockImplementation(() => {
          throw new Error("revoked request reached question state");
        });
        try {
          await expect(
            callQuestionRpc(method, method === "question.list" ? {} : { id }, {
              cfg: f.cfg,
              client: f.browser.client,
              registered: true,
              hasCurrentClientAuthority: () => false,
            }),
          ).rejects.toThrow("Gateway requester authority changed");
          expect(read).not.toHaveBeenCalled();
        } finally {
          read.mockRestore();
        }
        expect(manager.get(id)?.status).toBe("pending");
      });
    },
  );
});
