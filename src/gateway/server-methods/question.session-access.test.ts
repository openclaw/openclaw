import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { canReceiveSessionEvent } from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
  requesterAuthority,
  requestParams,
  secretRequestParams,
} from "./question.test-support.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

const sourceReleases = new Set<() => void>();
afterEach(() => {
  for (const release of sourceReleases) {
    release();
  }
  sourceReleases.clear();
});

function questionPeer(client: GatewayClient, connId: string) {
  const send = vi.fn();
  const socket = { readyState: 1, bufferedAmount: 0, send, close: vi.fn() };
  const ws: GatewayWsClient = {
    ...client,
    authenticatedUserProfile: client.authenticatedUserProfile
      ? {
          ...client.authenticatedUserProfile,
          avatarRevision: client.authenticatedUserProfile.avatarRevision ?? "",
        }
      : undefined,
    connId,
    usesSharedGatewayAuth: false,
    socket: socket as unknown as GatewayWsClient["socket"],
  };
  return { ws, send };
}

async function fixture(state: OpenClawTestState) {
  const owner = roleClient("view", "question-owner");
  const viewer = roleClient("write", "question-viewer");
  const cfg = rolePolicyConfig(["guest"]);
  cfg.gateway!.roles!.definitions.view!.scopes.push("operator.questions");
  cfg.gateway!.roles!.definitions.write!.sessions.others = "view";
  cfg.gateway!.roles!.definitions.write!.scopes.push("operator.questions");
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  owner.connect.scopes = ["operator.sessions.write"];
  viewer.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const sourceController = new AbortController();
  owner.internal = {
    ...owner.internal,
    operatorAccessAuthority: {
      signal: sourceController.signal,
      assertCurrent: () => sourceController.signal.throwIfAborted(),
    },
  };
  const source = await captureGatewayOperatorRunAuthority({
    client: owner,
    context: { getRuntimeConfig: () => cfg },
  });
  if (!source) {
    throw new Error("Expected admitted question source");
  }
  sourceReleases.add(source.release);
  const producer: GatewayClient = {
    ...owner,
    internal: {
      ...owner.internal,
      operatorRunAuthority: source.authority,
      agentRuntimeIdentity: adminRequestClient.internal!.agentRuntimeIdentity,
    },
  };
  const entry = {
    sessionId: "question-session",
    lifecycleRevision: "question-generation",
    updatedAt: 1,
    visibility: "shared" as const,
    createdActor: {
      type: "human" as const,
      source: "profile" as const,
      id: owner.authenticatedUserProfile!.profileId,
    },
  };
  const write = (delta: Partial<SessionEntry> = {}) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { ...entry, ...delta },
    );
  await write();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: requestParams.sessionKey })?.createdActor,
  ).toEqual(entry.createdActor);
  const call = (
    method: string,
    params: Record<string, unknown>,
    client = owner,
    current?: () => boolean,
  ) =>
    callQuestionRpc(method, params, {
      client,
      cfg,
      registered: true,
      hasCurrentClientAuthority: current,
    });
  const request = (id = "ordinary-question", client = producer) =>
    call("question.request", { ...requestParams, id, timeoutMs: 10_000 }, client);
  return { owner, viewer, producer, cfg, entry, write, call, request, sourceController };
}

it("keeps a trusted narrow question on worker-backed RPCs and fanout through label changes and completion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    const owner = questionPeer(f.owner, "sql-owner");
    const viewer = questionPeer(f.viewer, "sql-viewer");
    const broad = questionPeer(
      { ...f.owner, connect: { ...f.owner.connect, scopes: ["operator.questions"] } },
      "sql-broad",
    );
    const admin = questionPeer(adminRequestClient, "sql-admin");
    const revoked = questionPeer({ ...f.viewer, invalidated: true }, "sql-revoked");
    const fallback = vi.fn((client, sessionKeys, agentId, event, payload) =>
      canReceiveSessionEvent({ cfg: f.cfg, client, sessionKeys, agentId, event, payload }),
    );
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([owner.ws, viewer.ws, broad.ws, admin.ws, revoked.ws]),
      canReceiveSessionEvent: fallback,
    });
    broadcast.mockImplementation(broadcaster.broadcast);
    let sql = observeHostDataSql();
    const entered = createDeferredCore();
    const wait = manager.waitAnswer.bind(manager);
    const waitSpy = vi.spyOn(manager, "waitAnswer").mockImplementationOnce((...args) => {
      const result = wait(...args);
      entered.resolve();
      return result;
    });
    let settled: Promise<unknown> | undefined;
    try {
      expect(
        await f.call(
          "question.request",
          {
            ...requestParams,
            id: "trusted-route",
            agentId: "other",
            sessionKey: "agent:other:foreign",
            runId: "forged",
          },
          f.producer,
        ),
      ).toMatchObject([true, { id: "trusted-route" }, undefined]);
      expect(manager.get("trusted-route")).toMatchObject({
        agentId: "main",
        sessionKey: requestParams.sessionKey,
        runId: requestParams.runId,
      });
      expect((await f.call("question.get", { id: "trusted-route" }))[0]).toBe(true);
      expect((await f.call("question.list", {}))[0]).toBe(true);
      const waiting = f.call("question.waitAnswer", { id: "trusted-route" });
      settled = Promise.allSettled([waiting]);
      await Promise.race([entered.promise, waiting]);
      expect(waitSpy).toHaveBeenCalledOnce();
      waitSpy.mockRestore();
      expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
      sql.restore();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requestParams.sessionKey },
        {
          ...f.entry,
          updatedAt: 2,
          label: "Renamed while answering",
          markedUnreadAt: 2,
        },
      );
      sql = observeHostDataSql();
      const answers = { answers: { destination: ["Home"] } };
      expect(await f.call("question.resolve", { id: "trusted-route", answers })).toEqual([
        true,
        { status: "answered", answers },
        undefined,
      ]);
      // Completion retires requester liveness, not the ordinary question's retained read facts.
      releaseAgentRunDelegatedAuthority(requesterAuthority);
      expect(await waiting).toEqual([true, { status: "answered", answers }, undefined]);
      expect(await f.call("question.get", { id: "trusted-route" })).toMatchObject([
        true,
        { question: { status: "answered", answers } },
        undefined,
      ]);
      await manager.drain();
      for (const recipient of [owner, broad, admin]) {
        expect(recipient.send).toHaveBeenCalledTimes(2);
        expect(recipient.send.mock.calls.map(([frame]) => JSON.parse(frame).event)).toEqual([
          "question.requested",
          "question.resolved",
        ]);
      }
      expect(viewer.send).not.toHaveBeenCalled();
      expect(revoked.send).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
      expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
    } finally {
      waitSpy.mockRestore();
      sql.restore();
      manager.close();
      await settled;
      await manager.drain();
    }
  });
});

it("fans out requester-only questions after draft visibility changes with no global event grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    const owner = questionPeer(f.owner, "question-owner");
    const viewer = questionPeer(f.viewer, "question-viewer");
    const broad = questionPeer(
      { ...f.owner, connect: { ...f.owner.connect, scopes: ["operator.questions"] } },
      "broad-questions",
    );
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([owner.ws, viewer.ws, broad.ws]),
      canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) =>
        canReceiveSessionEvent({ cfg: f.cfg, client, sessionKeys, agentId, event, payload }),
    });
    broadcast.mockImplementation(broadcaster.broadcast);
    expect((await f.request())[0]).toBe(true);
    expect(owner.send).toHaveBeenCalledOnce();
    expect(viewer.send).not.toHaveBeenCalled();
    expect(broad.send).toHaveBeenCalledOnce();
    const requested = broadcast.mock.calls.find(([event]) => event === "question.requested")!;
    const get = vi.spyOn(manager, "get");
    try {
      broadcaster.broadcast(requested[0], requested[1], requested[2]);
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: requestParams.sessionKey },
      { ...f.entry, visibility: "draft" },
    );
    owner.send.mockClear();
    viewer.send.mockClear();
    broad.send.mockClear();
    manager.resolve("ordinary-question", { answers: { destination: ["Own answer"] } });
    await manager.drain();
    expect(owner.send).toHaveBeenCalledOnce();
    expect(viewer.send).not.toHaveBeenCalled();
    expect(broad.send).toHaveBeenCalledOnce();
    const resolved = broadcast.mock.calls.find(([event]) => event === "question.resolved")!;
    manager.reset();
    manager.request({ ...requestParams, id: "ordinary-question" });
    owner.send.mockClear();
    broad.send.mockClear();
    broadcaster.broadcast(resolved[0], resolved[1], resolved[2]);
    expect(owner.send).not.toHaveBeenCalled();
    // Prepared sharing is scoped to the original synchronous fanout, including broad clients.
    expect(broad.send).not.toHaveBeenCalled();
    for (const event of [
      "question.requested",
      "question.resolved",
      "exec.approval.requested",
      "config.changed",
    ]) {
      owner.send.mockClear();
      viewer.send.mockClear();
      broadcaster.broadcast(event, { id: "unbound" });
      expect(owner.send).not.toHaveBeenCalled();
      expect(viewer.send).not.toHaveBeenCalled();
    }
    broadcaster.broadcast("chat.metadata.changed", {});
    for (const recipient of [owner, viewer]) {
      expect(recipient.send).toHaveBeenCalledOnce();
      expect(JSON.parse(recipient.send.mock.calls[0]![0])).toMatchObject({
        event: "chat.metadata.changed",
        payload: {},
      });
    }
  });
});

it.each(["ordinary", "secret"] as const)(
  "conceals privileged %s questions from narrow readers and fanout",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const { ws, send } = questionPeer(f.owner, "narrow-secret");
      broadcast.mockImplementation(
        createGatewayBroadcaster({ clients: new GatewayClientRegistry([ws]) }).broadcast,
      );
      const id = "privileged-question";
      const client =
        kind === "secret"
          ? adminRequestClient
          : {
              ...f.producer,
              connect: { ...f.producer.connect, scopes: ["operator.questions"] },
            };
      const params = { ...(kind === "secret" ? secretRequestParams : requestParams), id };
      expect((await f.call("question.request", params, client))[0]).toBe(true);
      if (kind === "secret") {
        const answers = { answers: { secret_value: ["synthetic-test-value"] } };
        expect((await f.call("question.resolve", { id, answers }, client))[0]).toBe(true);
        await manager.drain();
        expect(broadcast.mock.calls.map(([event]) => event)).toEqual([
          "question.requested",
          "question.resolved",
        ]);
      } else {
        expect(manager.observe(id)?.sessionAccess).toBeDefined();
        expect(await f.call("question.resolve", { id, cancel: true })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
      }
      for (const method of ["question.get", "question.waitAnswer"]) {
        expect(await f.call(method, { id })).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
      }
      expect(await f.call("question.list", {})).toEqual([true, { questions: [] }, undefined]);
      expect(manager.get(id)?.status).toBe(kind === "secret" ? "answered" : "pending");
      expect((await f.call("question.get", { id }, client))[0]).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });
  },
);

it.each(["pending", "answered"] as const)(
  "retains physical store identity while %s",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      expect((await f.request())[0]).toBe(true);
      if (status === "answered") {
        manager.resolve("ordinary-question", { answers: { destination: ["Original"] } });
      }
      const observation = manager.observe("ordinary-question")!;
      const waiting = manager.waitAnswer("ordinary-question");
      const replacement = state.statePath("replacement", "catalog.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
        f.entry,
      );
      f.cfg.session = { ...f.cfg.session, store: replacement };
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
      expect(await f.call("question.get", { id: "ordinary-question" })).toMatchObject([
        false,
        undefined,
        { details: { reason: "QUESTION_NOT_FOUND" } },
      ]);
      expect(observation.record.status).toBe(status === "pending" ? "cancelled" : status);
      expect(await waiting).toMatchObject({ status: status === "pending" ? "cancelled" : status });
      expect(await f.call("question.waitAnswer", { id: "ordinary-question" })).toMatchObject([
        false,
        undefined,
        { details: { reason: "QUESTION_NOT_FOUND" } },
      ]);
      expect(manager.get("ordinary-question")?.status).toBe(
        status === "pending" ? "cancelled" : status,
      );
    });
  },
);

it.each(["closed claim", "absent", "incognito", "disallowed agent"] as const)(
  "refuses narrow question creation with %s before creating a record",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      let client = f.producer;
      if (kind === "closed claim") {
        releaseAgentRunDelegatedAuthority(requesterAuthority);
      }
      if (kind === "disallowed agent") {
        f.cfg.gateway!.roles!.definitions.view!.agents = ["guest"];
        await state.writeConfig(f.cfg);
        setRuntimeConfigSnapshot(f.cfg);
      }
      if (kind === "absent") {
        client = {
          ...client,
          internal: {
            ...client.internal,
            agentRuntimeIdentity: {
              ...client.internal!.agentRuntimeIdentity!,
              sessionKey: "agent:main:missing",
            },
          },
        };
      }
      if (kind === "incognito") {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: requestParams.sessionKey },
          { ...f.entry, incognito: true },
        );
      }
      const response = await f.call(
        "question.request",
        {
          ...requestParams,
          id: "refused-question",
        },
        client,
      );
      expect(response[0]).toBe(false);
      expect(response[1]).toBeUndefined();
      expect(manager.get("refused-question")).toBeNull();
    });
  },
);

it.each(["generation", "session", "profile", "reused id"] as const)(
  "rechecks held answer delivery after %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const id = "ordinary-question";
      expect((await f.request(id))[0]).toBe(true);
      const entered = createDeferredCore();
      const wait = manager.waitAnswer.bind(manager);
      const spy = vi.spyOn(manager, "waitAnswer").mockImplementation((...args) => {
        const result = wait(...args);
        entered.resolve();
        return result;
      });
      const observer = { ...f.owner };
      const waiting = f.call("question.waitAnswer", { id }, observer);
      const settled = Promise.allSettled([waiting]);
      const answers = { answers: { destination: ["Committed answer"] } };
      try {
        await Promise.race([entered.promise, waiting]);
        expect(spy).toHaveBeenCalledOnce();
        if (change === "generation") {
          await f.write({ lifecycleRevision: "replacement" });
        }
        if (change === "session") {
          await f.write({ sessionId: "replacement" });
        }
        if (change === "profile") {
          observer.authenticatedUserProfile = f.viewer.authenticatedUserProfile;
        }
        if (change === "reused id") {
          manager.reset();
          manager.request({ ...requestParams, id });
        } else {
          manager.resolve(id, answers);
        }
        const outcome = (await settled)[0];
        const error =
          change === "profile"
            ? { code: "FORBIDDEN", message: "Gateway requester authority changed" }
            : { details: { reason: "QUESTION_NOT_FOUND" } };
        expect(outcome).toMatchObject({
          status: "fulfilled",
          value: [false, undefined, error],
        });
        expect(manager.get(id)?.status).toBe(change === "reused id" ? "pending" : "answered");
      } finally {
        manager.close();
        await settled;
        spy.mockRestore();
      }
    });
  },
);

it.each([
  "close",
  "reused id",
  "generation",
  "unrelated",
  "publication delay",
  "database close",
  "database replacement",
] as const)(
  "joins terminal preparation after %s without publishing stale facts or undoing the answer",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const owner = questionPeer(f.owner, "held-owner");
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry([owner.ws]),
      });
      broadcast.mockImplementation(broadcaster.broadcast);
      expect((await f.request())[0]).toBe(true);
      owner.send.mockClear();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      let held = false;
      const spy = vi
        .spyOn(projectionLane.pool, "run")
        .mockImplementation(async (input, options) => {
          let exact = false;
          const result = await run(async () => {
            const request = typeof input === "function" ? await input() : input;
            exact = request.kind === "session-exact-entries";
            return request;
          }, options);
          if (exact && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const answer = { answers: { destination: ["Committed"] } };
      const observation = manager.observe("ordinary-question")!;
      const releaseAccess =
        change === "publication delay"
          ? vi.spyOn(observation.sessionAccess!, "release")
          : undefined;
      const waiting = manager.waitAnswer("ordinary-question");
      manager.resolve("ordinary-question", answer);
      try {
        await entered.promise;
        expect(await waiting).toEqual({ status: "answered", answers: answer });
        expect(manager.get("ordinary-question")?.status).toBe("answered");
        if (change === "publication delay") {
          await vi.advanceTimersByTimeAsync(15_001);
          expect(observation.isCurrent()).toBe(true);
          expect(releaseAccess).not.toHaveBeenCalled();
          expect(manager.get("ordinary-question")).toMatchObject({
            status: "answered",
            answers: answer,
          });
          expect(owner.send).not.toHaveBeenCalled();
        }
        if (change === "reused id") {
          manager.reset();
        }
        if (change === "close") {
          manager.close();
        }
        if (change === "reused id") {
          manager.request({ ...requestParams, id: "ordinary-question" });
        }
        if (change === "generation") {
          await f.write({ lifecycleRevision: "replacement" });
        }
        if (change === "database close") {
          await closeOpenClawAgentDatabaseByPathAsync(
            resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          );
        }
        if (change === "database replacement") {
          const replacement = state.statePath("replacement.sqlite");
          await upsertSessionEntryCore(
            { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
            f.entry,
          );
          await closeOpenClawAgentDatabaseByPathAsync(replacement);
          const original = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
          fs.renameSync(original, state.statePath("original.sqlite"));
          fs.copyFileSync(replacement, original);
        }
        if (change === "unrelated") {
          sessionChanges.emit({ agentId: "main", sessionKey: "agent:main:unrelated" });
        }
        release.resolve();
        await manager.drain();
        expect(owner.send).toHaveBeenCalledTimes(
          ["unrelated", "publication delay"].includes(change) ? 1 : 0,
        );
        if (change === "publication delay") {
          expect(JSON.parse(String(owner.send.mock.calls[0]?.[0]))).toMatchObject({
            type: "event",
            event: "question.resolved",
            payload: { id: "ordinary-question", status: "answered", answers: answer },
          });
        }
        if (change === "publication delay") {
          await vi.advanceTimersByTimeAsync(14_999);
          expect(observation.isCurrent()).toBe(true);
          expect(releaseAccess).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expect(manager.get("ordinary-question")).toBeNull();
          expect(releaseAccess).toHaveBeenCalledOnce();
        }
        if (change === "unrelated") {
          expect(spy).toHaveBeenCalledOnce();
        }
        if (change === "generation") {
          expect(manager.get("ordinary-question")).toMatchObject({
            status: "answered",
            answers: answer,
          });
        }
        if (change === "reused id") {
          expect(manager.get("ordinary-question")?.status).toBe("pending");
        }
      } finally {
        release.resolve();
        await manager.drain();
        spy.mockRestore();
        releaseAccess?.mockRestore();
      }
    });
  },
);

it.each([
  ["get", "request authority", "narrow"],
  ["get", "observer scope", "narrow"],
  ["request", "request authority", "admin"],
  ["request", "request authority", "broad"],
] as const)(
  "fences question.%s when its %s closes during %s worker preparation",
  async (method, owner, kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      if (method === "get") {
        expect((await f.request())[0]).toBe(true);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const run = projectionLane.pool.run.bind(projectionLane.pool);
      const spy = vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
        const result = await run(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
      let current = true;
      const observer = new AsyncWorkScope();
      broadcast.mockClear();
      const client =
        kind === "admin"
          ? adminRequestClient
          : kind === "narrow"
            ? f.owner
            : {
                ...f.producer,
                connect: { ...f.producer.connect, scopes: ["operator.questions"] },
              };
      const call = () =>
        f.call(
          `question.${method}`,
          { ...(method === "request" ? requestParams : {}), id: "ordinary-question" },
          client,
          () => current,
        );
      const request = method === "get" ? observer.track(call) : call();
      const result = Promise.allSettled([request]);
      try {
        await entered.promise;
        if (method === "get") {
          await f.write({ updatedAt: 2 });
        }
        if (owner === "request authority") {
          current = false;
        } else {
          observer.beginClose();
        }
        release.resolve();
        if (method === "get") {
          expect((await result)[0]).toMatchObject({
            status: "rejected",
            reason:
              owner === "request authority"
                ? { message: "Gateway requester authority changed" }
                : { name: "AbortError" },
          });
          expect(spy).toHaveBeenCalledOnce();
          expect(manager.get("ordinary-question")?.status).toBe("pending");
        } else {
          expect((await result)[0]).toMatchObject({ status: "rejected" });
          expect(manager.get("ordinary-question")).toBeNull();
        }
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await result;
        await observer.drain();
        spy.mockRestore();
      }
    });
  },
);

it.each(["admin", "narrow"] as const)(
  "preserves %s creation semantics when optional worker facts are unavailable",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const failure = new Error("question fixture worker unavailable");
      const admin = questionPeer(adminRequestClient, "optional-admin");
      const narrow = questionPeer(f.viewer, "optional-narrow");
      const fallback = vi.fn(() => {
        throw new Error("Unexpected synchronous session sharing lookup");
      });
      broadcast.mockImplementation(
        createGatewayBroadcaster({
          clients: new GatewayClientRegistry([admin.ws, narrow.ws]),
          canReceiveSessionEvent: fallback,
        }).broadcast,
      );
      const spy = vi.spyOn(projectionLane.pool, "run").mockRejectedValue(failure);
      try {
        const client = kind === "narrow" ? f.producer : adminRequestClient;
        const request = f.call(
          "question.request",
          { ...requestParams, id: "optional-facts" },
          client,
        );
        if (kind === "narrow") {
          await expect(request).rejects.toThrow(failure);
          expect(manager.get("optional-facts")).toBeNull();
        } else {
          expect((await request)[0]).toBe(true);
          expect(manager.get("optional-facts")?.status).toBe("pending");
          expect(manager.observe("optional-facts")?.sessionAccess).toBeUndefined();
          manager.cancel("optional-facts");
          await manager.drain();
          expect(admin.send.mock.calls.map(([frame]) => JSON.parse(frame).event)).toEqual([
            "question.requested",
            "question.resolved",
          ]);
          expect(manager.get("optional-facts")?.status).toBe("cancelled");
        }
        expect(narrow.send).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each(["source", "generation"] as const)(
  "preserves current broad and admin terminal delivery after the original narrow %s retires",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      const source = f.sourceController;
      const narrow = questionPeer(f.owner, "retired-narrow");
      const broad = questionPeer(
        { ...f.viewer, connect: { ...f.viewer.connect, scopes: ["operator.questions"] } },
        "retired-broad",
      );
      const admin = questionPeer(adminRequestClient, "retired-admin");
      broadcast.mockImplementation(
        createGatewayBroadcaster({
          clients: new GatewayClientRegistry([narrow.ws, broad.ws, admin.ws]),
        }).broadcast,
      );
      expect((await f.request())[0]).toBe(true);
      for (const recipient of [narrow, broad, admin]) {
        expect(recipient.send).toHaveBeenCalledOnce();
        recipient.send.mockClear();
      }
      if (change === "source") {
        source.abort(new Error("Original producer revoked"));
        releaseAgentRunDelegatedAuthority(requesterAuthority);
      } else {
        await f.write({ lifecycleRevision: "successor" });
        manager.resolve("ordinary-question", { answers: { destination: ["Committed"] } });
      }
      await manager.drain();
      const status = change === "source" ? "cancelled" : "answered";
      expect(manager.get("ordinary-question")?.status).toBe(status);
      expect(narrow.send).not.toHaveBeenCalled();
      for (const recipient of [broad, admin]) {
        expect(recipient.send).toHaveBeenCalledOnce();
        expect(JSON.parse(recipient.send.mock.calls[0]![0])).toMatchObject({
          event: "question.resolved",
          payload: { id: "ordinary-question", status },
        });
      }
    });
  },
);
