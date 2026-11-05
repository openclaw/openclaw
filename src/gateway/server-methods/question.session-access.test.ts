import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionEntryReads from "../../config/sessions/session-entry-read-runtime.js";
import {
  executeSessionQuestionOperation,
  readSessionQuestionCustody,
} from "../../config/sessions/session-questions.js";
import type { DurableQuestion } from "../../config/sessions/session-questions.types.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import { projectionLane } from "../../config/sessions/session-transcript-worker-resources.js";
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
import { installDurableQuestion } from "../durable-question-runtime.js";
import { publishDurableQuestionResolution } from "../question-session-access.js";
import { createDurableQuestionSessionAccess } from "../question-session-durable-access.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createProjectedSessionEventPredicate } from "../session-sharing.test-utils.js";
import { createQuestionSessionAccessFixtureOwner } from "./question.session-access.test-support.js";
import {
  adminRequestClient,
  broadcast,
  installQuestionTestHooks,
  manager,
  requesterAuthority,
  requestParams,
  secretRequestParams,
} from "./question.test-support.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayClient } from "./types.js";

installQuestionTestHooks();

function invalidateQuestionReadFacts() {
  sessionChanges.invalidate({
    agentId: "main",
    sessionKey: requestParams.sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    factsInvalidated: true,
  });
}

const { fixture, questionPeer, retainCleanup } = createQuestionSessionAccessFixtureOwner();

function useBroadcaster(
  peers: ReturnType<typeof questionPeer>[],
  canReceiveSessionEvent?: Parameters<typeof createGatewayBroadcaster>[0]["canReceiveSessionEvent"],
) {
  const broadcaster = createGatewayBroadcaster({
    clients: new GatewayClientRegistry(peers.map(({ ws }) => ws)),
    canReceiveSessionEvent,
  });
  broadcast.mockImplementation(broadcaster.broadcast);
  return broadcaster;
}

function expectMissing(response: unknown) {
  expect(response).toMatchObject([false, undefined, { details: { reason: "QUESTION_NOT_FOUND" } }]);
}

function expectEvents(peer: ReturnType<typeof questionPeer>, events: string[]) {
  expect(peer.send).toHaveBeenCalledTimes(events.length);
  expect(peer.send.mock.calls.map(([frame]) => JSON.parse(frame).event)).toEqual(events);
}

function broadQuestionClient(client: GatewayClient): GatewayClient {
  return { ...client, connect: { ...client.connect, scopes: ["operator.questions"] } };
}

function observeAnswerWait() {
  const entered = createDeferredCore();
  const wait = manager.waitAnswer.bind(manager);
  const spy = vi.spyOn(manager, "waitAnswer").mockImplementation((...args) => {
    const result = wait(...args);
    entered.resolve();
    return result;
  });
  return { entered: entered.promise, spy };
}

function withQuestionFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>, state: OpenClawTestState) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await run(await fixture(state), state);
  });
}

it("keeps a trusted narrow question on worker-backed RPCs and fanout through label changes and completion", () =>
  withQuestionFixture(async (f) => {
    const owner = questionPeer(f.owner, "sql-owner");
    const viewer = questionPeer(f.viewer, "sql-viewer");
    const broad = questionPeer(broadQuestionClient(f.owner), "sql-broad");
    const admin = questionPeer(adminRequestClient, "sql-admin");
    const revoked = questionPeer({ ...f.viewer, invalidated: true }, "sql-revoked");
    const fallback = vi.fn(() => false);
    useBroadcaster([owner, viewer, broad, admin, revoked], fallback);
    let sql = observeHostDataSql();
    const { entered, spy: waitSpy } = observeAnswerWait();
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
      await Promise.race([entered, waiting]);
      expect(waitSpy).toHaveBeenCalledOnce();
      waitSpy.mockRestore();
      expect(sql.queries.filter((query) => /session_|transcript_/i.test(query))).toEqual([]);
      sql.restore();
      await f.write({ updatedAt: 2, label: "Renamed while answering", markedUnreadAt: 2 });
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
        expectEvents(recipient, ["question.requested", "question.resolved"]);
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
  }));

it("fans out requester-only questions after draft visibility changes with no global event grant", () =>
  withQuestionFixture(async (f) => {
    const owner = questionPeer(f.owner, "question-owner");
    const viewer = questionPeer(f.viewer, "question-viewer");
    const broad = questionPeer(broadQuestionClient(f.owner), "broad-questions");
    const projection = await createSessionRowProjection({ cfg: f.cfg });
    retainCleanup(() => projection.dispose());
    await projection.ensureMaterialized();
    const broadcaster = useBroadcaster(
      [owner, viewer, broad],
      createProjectedSessionEventPredicate(f.cfg, projection),
    );
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
    await f.write({ visibility: "draft" });
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
  }));

it.each(["ordinary", "secret"] as const)(
  "conceals privileged %s questions from narrow readers and fanout",
  (kind) =>
    withQuestionFixture(async (f) => {
      const peer = questionPeer(f.owner, "narrow-secret");
      useBroadcaster([peer]);
      const id = "privileged-question";
      const client = kind === "secret" ? adminRequestClient : broadQuestionClient(f.producer);
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
        expectMissing(await f.call("question.resolve", { id, cancel: true }));
      }
      for (const method of ["question.get", "question.waitAnswer"]) {
        expectMissing(await f.call(method, { id }));
      }
      expect(await f.call("question.list", {})).toEqual([true, { questions: [] }, undefined]);
      expect(manager.get(id)?.status).toBe(kind === "secret" ? "answered" : "pending");
      expect((await f.call("question.get", { id }, client))[0]).toBe(true);
      expect(peer.send).not.toHaveBeenCalled();
    }),
);

it.each(["pending", "answered"] as const)("retains physical store identity while %s", (status) =>
  withQuestionFixture(async (f, state) => {
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
    expectMissing(await f.call("question.get", { id: "ordinary-question" }));
    expect(observation.record.status).toBe(status === "pending" ? "cancelled" : status);
    expect(await waiting).toMatchObject({ status: status === "pending" ? "cancelled" : status });
    expectMissing(await f.call("question.waitAnswer", { id: "ordinary-question" }));
    expect(manager.get("ordinary-question")?.status).toBe(
      status === "pending" ? "cancelled" : status,
    );
  }),
);

it.each(["closed claim", "absent", "incognito", "disallowed agent"] as const)(
  "refuses narrow question creation with %s before creating a record",
  (kind) =>
    withQuestionFixture(async (f, state) => {
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
        await f.write({ incognito: true });
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
    }),
);

it.each(["generation", "session", "profile", "reused id"] as const)(
  "rechecks held answer delivery after %s",
  (change) =>
    withQuestionFixture(async (f) => {
      const id = "ordinary-question";
      expect((await f.request(id))[0]).toBe(true);
      const { entered, spy } = observeAnswerWait();
      const observer = { ...f.owner };
      const waiting = f.call("question.waitAnswer", { id }, observer);
      const settled = Promise.allSettled([waiting]);
      const answers = { answers: { destination: ["Committed answer"] } };
      try {
        await Promise.race([entered, waiting]);
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
    }),
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
  (change) =>
    withQuestionFixture(async (f, state) => {
      const owner = questionPeer(f.owner, "held-owner");
      useBroadcaster([owner]);
      expect((await f.request())[0]).toBe(true);
      owner.send.mockClear();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      invalidateQuestionReadFacts();
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
          // Offline replacement retires its canonical owner before changing the file.
          await closeOpenClawAgentDatabaseByPathAsync(original);
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
        if (["generation", "database replacement"].includes(change)) {
          expect(manager.get("ordinary-question")).toMatchObject({
            status: "answered",
            answers: answer,
          });
        }
        if (change === "database replacement") {
          // Retire the fixture's retained observation before admitting the successor.
          manager.reset();
          await expect(
            sessionEntryReads.readSessionEntryReadOnlyInWorker({
              agentId: "main",
              storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
              sessionKey: requestParams.sessionKey,
            }),
          ).resolves.toMatchObject({
            sessionId: f.entry.sessionId,
            lifecycleRevision: f.entry.lifecycleRevision,
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
    }),
);

it.each([
  ["get", "request authority", "narrow"],
  ["get", "observer scope", "narrow"],
  ["request", "request authority", "admin"],
  ["request", "request authority", "broad"],
] as const)(
  "fences question.%s when its %s closes during %s worker preparation",
  (method, owner, kind) =>
    withQuestionFixture(async (f) => {
      if (method === "get") {
        expect((await f.request())[0]).toBe(true);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      invalidateQuestionReadFacts();
      const read = sessionEntryReads.withSessionEntriesFromStoresInWorker;
      const spy = vi
        .spyOn(sessionEntryReads, "withSessionEntriesFromStoresInWorker")
        .mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return read(...args);
        });
      let current = true;
      const observer = new AsyncWorkScope();
      broadcast.mockClear();
      const client =
        kind === "admin"
          ? adminRequestClient
          : kind === "narrow"
            ? f.owner
            : broadQuestionClient(f.producer);
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
    }),
);

it.each(["admin", "narrow"] as const)(
  "preserves %s creation semantics when optional worker facts are unavailable",
  (kind) =>
    withQuestionFixture(async (f) => {
      const failure = new Error("question fixture worker unavailable");
      const admin = questionPeer(adminRequestClient, "optional-admin");
      const narrow = questionPeer(f.viewer, "optional-narrow");
      const fallback = vi.fn(() => {
        throw new Error("Unexpected synchronous session sharing lookup");
      });
      useBroadcaster([admin, narrow], fallback);
      const spy = vi
        .spyOn(sessionEntryReads, "withSessionEntriesFromStoresInWorker")
        .mockRejectedValue(failure);
      try {
        invalidateQuestionReadFacts();
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
          expectEvents(admin, ["question.requested", "question.resolved"]);
          expect(manager.get("optional-facts")?.status).toBe("cancelled");
        }
        expect(narrow.send).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }),
);

it.each(["source", "generation"] as const)(
  "preserves current broad and admin terminal delivery after the original narrow %s retires",
  (change) =>
    withQuestionFixture(async (f) => {
      const source = f.sourceController;
      const narrow = questionPeer(f.owner, "retired-narrow");
      const broad = questionPeer(broadQuestionClient(f.viewer), "retired-broad");
      const admin = questionPeer(adminRequestClient, "retired-admin");
      useBroadcaster([narrow, broad, admin]);
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
    }),
);

it("publishes server-owned terminal receipts to current own-session recipients and denies revoked recipients", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    const owner = questionPeer(f.owner, "receipt-owner");
    const revoked = questionPeer({ ...f.owner, invalidated: true }, "receipt-revoked");
    const viewer = questionPeer(f.viewer, "receipt-viewer");
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([owner.ws, revoked.ws, viewer.ws]),
    });
    broadcast.mockImplementation(broadcaster.broadcast);
    expect((await f.request("server-receipt"))[0]).toBe(true);
    const observation = manager.observe("server-receipt")!;
    manager.resolve("server-receipt", { answers: { destination: ["Own answer"] } });
    await manager.drain();
    for (const peer of [owner, revoked, viewer]) {
      peer.send.mockClear();
    }
    const publication = {
      context: {
        getRuntimeConfig: () => f.cfg,
        broadcast: broadcaster.broadcast,
      } as GatewayRequestContext,
      event: {
        id: "server-receipt",
        status: "answered" as const,
        answers: { answers: { destination: ["Own answer"] } },
      },
      observation,
      assertCurrent() {},
    };
    await publishDurableQuestionResolution(publication);
    expect(owner.send).toHaveBeenCalledOnce();
    expect(revoked.send).not.toHaveBeenCalled();
    expect(viewer.send).not.toHaveBeenCalled();
    owner.send.mockClear();
    f.sourceController.abort(new Error("Original source revoked"));
    await publishDurableQuestionResolution(publication);
    expect(owner.send).not.toHaveBeenCalled();
  });
});

it.each(["original member", "configured-only member", "revoked original member"] as const)(
  "reads and settles restored original-store custody after routing changes (%s)",
  async (membership) => {
    vi.useRealTimers();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture(state);
      expect((await f.request("original-store-question"))[0]).toBe(true);
      const original = manager.observe("original-store-question")!;
      const binding = original.sessionAccess?.durableBinding;
      if (!binding) {
        throw new Error("Expected native captured conversation binding");
      }
      const record = structuredClone(original.record);
      const question: DurableQuestion = {
        record,
        sessionKey: binding.sessionKey,
        sessionId: binding.sessionId,
        lifecycleRevision: binding.lifecycleRevision,
        sessionBinding: binding,
        provenance: { issuer: "operator", sourceRunId: requestParams.runId },
        continuation: { status: "pending" },
      };
      const canonical = await executeSessionQuestionOperation(
        {
          agentId: binding.agentId,
          sessionKey: binding.sessionKey,
          storePath: binding.storePath,
          assertCurrent() {},
        },
        { kind: "register", question },
      );
      if (!canonical || Array.isArray(canonical)) {
        throw new Error("Expected canonical native question registration");
      }
      manager.reset();
      const continuationOwed = vi.fn();
      installDurableQuestion(manager, canonical, continuationOwed);
      const replacement = state.statePath("replacement", "catalog.sqlite");
      await upsertSessionEntryCore(
        { agentId: "main", storePath: replacement, sessionKey: requestParams.sessionKey },
        { ...f.entry, sessionId: "different-configured-session" },
      );
      const memberId = f.viewer.authenticatedUserProfile!.profileId;
      const originalScope = {
        agentId: binding.agentId,
        storePath: binding.storePath,
        sessionKey: binding.sessionKey,
      };
      await addSessionMember(
        { ...originalScope, storePath: replacement },
        { identityId: memberId, addedBy: "owner" },
      );
      if (membership !== "configured-only member") {
        await addSessionMember(originalScope, { identityId: memberId, addedBy: "owner" });
      }
      const caller = {
        ...f.viewer,
        connect: { ...f.viewer.connect, scopes: ["operator.questions"] },
      };
      f.cfg.gateway!.roles!.definitions.write!.agents = "*";
      f.cfg.session = { ...f.cfg.session, store: replacement };
      await state.writeConfig(f.cfg);
      setRuntimeConfigSnapshot(f.cfg);
      expect(await f.call("question.get", { id: record.id }, caller)).toEqual([
        true,
        { question: record },
        undefined,
      ]);
      expect(await f.call("question.list", {}, caller)).toEqual([
        true,
        { questions: [record] },
        undefined,
      ]);
      if (membership === "revoked original member") {
        await removeSessionMember(originalScope, memberId);
      }
      const answers = { answers: { destination: ["Home"] } };
      const resolution = await f.call("question.resolve", { id: record.id, answers }, caller);
      if (membership !== "original member") {
        expect(resolution).toMatchObject([
          false,
          undefined,
          { details: { reason: "QUESTION_NOT_FOUND" } },
        ]);
        expect(continuationOwed).not.toHaveBeenCalled();
        expect(await readSessionQuestionCustody(binding, record.id, () => {})).toMatchObject({
          record: { status: "pending" },
          continuation: { status: "pending" },
        });
      } else {
        expect(resolution).toEqual([true, { status: "answered", answers }, undefined]);
        expect(continuationOwed).toHaveBeenCalledOnce();
        expect(await readSessionQuestionCustody(binding, record.id, () => {})).toMatchObject({
          record: { status: "answered", answers },
          continuation: { status: "owed" },
        });
      }
      expect(
        await executeSessionQuestionOperation(
          {
            agentId: "main",
            sessionKey: binding.sessionKey,
            storePath: replacement,
            assertCurrent() {},
          },
          { kind: "get", id: record.id },
        ),
      ).toBeUndefined();
      if (membership === "original member") {
        expect(
          await f.call("question.resolve", {
            id: record.id,
            answers: { answers: { destination: ["Office"] } },
          }),
        ).toEqual([true, { status: "answered", answers }, undefined]);
      }
      // A healthy old physical source stays usable; its generation still revokes access.
      await upsertSessionEntryCore(
        { agentId: "main", storePath: binding.storePath, sessionKey: binding.sessionKey },
        { ...f.entry, lifecycleRevision: "original-store-successor" },
      );
      expect(await f.call("question.get", { id: record.id })).toMatchObject([
        false,
        undefined,
        { details: { reason: "QUESTION_NOT_FOUND" } },
      ]);
    });
  },
);

it("keeps durable broad terminal publication bound to the original conversation after producer retirement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = await fixture(state);
    expect((await f.request("durable-broad-receipt"))[0]).toBe(true);
    const original = manager.observe("durable-broad-receipt")!;
    const binding = original.sessionAccess?.durableBinding;
    if (!binding) {
      throw new Error("Expected native captured conversation binding");
    }
    manager.reset();
    manager.request({
      ...original.record,
      timeoutMs: 900_000,
      sessionAccess: createDurableQuestionSessionAccess(binding),
    });
    manager.resolve("durable-broad-receipt", { answers: { destination: ["Private answer"] } });
    const observation = manager.observe("durable-broad-receipt")!;
    const broad = questionPeer(
      { ...f.viewer, connect: { ...f.viewer.connect, scopes: ["operator.questions"] } },
      "durable-broad",
    );
    const admin = questionPeer(adminRequestClient, "durable-admin");
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([broad.ws, admin.ws]),
    });
    const publication = {
      context: {
        getRuntimeConfig: () => f.cfg,
        broadcast: broadcaster.broadcast,
      } as GatewayRequestContext,
      event: {
        id: "durable-broad-receipt",
        status: "answered" as const,
        answers: { answers: { destination: ["Private answer"] } },
      },
      observation,
      assertCurrent() {},
    };
    f.sourceController.abort(new Error("Retired asking producer"));
    await publishDurableQuestionResolution(publication);
    for (const recipient of [broad, admin]) {
      expect(recipient.send).toHaveBeenCalledOnce();
      recipient.send.mockClear();
    }
    await f.write({ lifecycleRevision: "successor" });
    await publishDurableQuestionResolution(publication);
    for (const recipient of [broad, admin]) {
      expect(recipient.send).not.toHaveBeenCalled();
    }
  });
});
