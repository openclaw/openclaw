/** Parent cancellation survives an unreadable descendant partition without hiding failure. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import * as subagentControlSession from "../../agents/subagents/registry/subagent-control-session.js";
import { createControlRunFixture } from "../../agents/subagents/registry/subagent-control.fixtures.test-support.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../agents/subagents/registry/subagent-control.types.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { isSameSubagentRunOwner } from "../../agents/subagents/registry/subagent-run-generation.js";
import { releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "../../auto-reply/reply/abort.js";
import { initSessionState } from "../../auto-reply/reply/session.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  appendTranscriptMessageSync,
  loadExactSessionEntryReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createGatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  trackSessionControllerSourceWork,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  registerRpcSource,
  requestRpcSourceCancellation,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { listOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.test-support.js";
import { finishFailedGatewayHttpResponse } from "../http-common.js";
import { handleSessionKillHttpRequest } from "../session-kill-http.js";
import * as sessionUtils from "../session-utils.js";
import * as chatAbortDescendants from "./chat-abort-descendants.js";
import {
  handleChatAbortRequest,
  handleChatAbortRequestWithLifecycle,
} from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

const fixture = useChatAbortRegistryFixture();
afterEach(() => vi.restoreAllMocks());

async function corruptChildDatabase(storePath: string, sessionKey: string) {
  const database = listOpenClawAgentDatabasesForTest().find(
    (item) => item.agentId === "broken" && isPathInside(fixture.stateDir, item.path),
  );
  expect(database).toBeDefined();
  expect(await closeOpenClawAgentDatabaseByPathAsync(database!.path, "broken")).toBe(true);
  await writeFile(database!.path, "not a SQLite database");
  expect(() => loadExactSessionEntryReadOnly({ storePath, sessionKey })).toThrow();
}

it.each(["exact", "session cascade", "typed stop", "channel stop", "embedded stop"])(
  "%s stops the healthy parent and siblings despite nested corrupt child databases",
  async (boundary) => {
    const sessionKey = "agent:main:main";
    const badKey = "agent:broken:subagent:bad";
    const healthyKey = "agent:main:subagent:healthy";
    const parentStore = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: "parent-session",
    });
    const badStore = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "broken",
      sessionKey: badKey,
      defaultSessionId: "bad-session",
    });
    const rootKey = "agent:main:subagent:root";
    const secondBadKey = "agent:broken:subagent:second-bad";
    for (const [runId, childSessionKey] of [
      ["root", rootKey],
      ["second-bad", secondBadKey],
      ["bad", badKey],
      ["healthy", healthyKey],
    ] as const) {
      const childAgentId = runId === "bad" || runId === "second-bad" ? "broken" : "main";
      await fixture.seedRun({
        runId,
        childSessionKey,
        childAgentId,
        requesterSessionKey: runId !== "root" ? rootKey : sessionKey,
        requesterDisplayKey: "main",
        queued: true,
        lifecycleRevision: "original-child",
      });
    }
    await corruptChildDatabase(badStore, badKey);
    const badDispatch = vi.fn(async () => {});
    const healthyDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    for (const [runId, start] of [
      ["bad", badDispatch],
      ["healthy", healthyDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      fixture.queueRun({
        groupId: "errors",
        runId,
        activeRunIds: ["capacity"],
        start,
      });
    }
    const cfg = getRuntimeConfig();
    const parent = createActiveRun(sessionKey, {
      runId: "parent",
      sessionId: "parent-session",
      storeScope: parentStore,
      agentId: "main",
      owner: { connId: "owner" },
    });
    const signal = vi.fn(() => {
      expect(releaseSwarmRun("capacity")).toBe(true);
      expect(badDispatch).not.toHaveBeenCalled();
      expect(healthyDispatch).not.toHaveBeenCalled();
    });
    parent.input.abortSignal.addEventListener("abort", signal);
    const operation = parent.input.claim?.operation;
    if (!operation) {
      throw new Error("Expected the parent fixture operation");
    }
    operation.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      cancel: () => requestRpcSourceCancellation(parent),
    });
    const context = createChatAbortContext({ getRuntimeConfig: () => cfg });
    const embedded = createEmbeddedRunHandle({
      runId: "parent",
      abort: () => {
        requestRpcSourceCancellation(parent);
        clearActiveEmbeddedRun("parent-session", embedded, sessionKey);
      },
    });
    if (boundary === "embedded stop") {
      setActiveEmbeddedRun("parent-session", embedded, sessionKey);
      context.getSessionEventSubscriberConnIds = () => new Set();
    } else {
      registerRpcSource("parent", parent);
    }
    try {
      const result =
        boundary === "channel stop"
          ? await tryFastAbortFromMessage({
              cfg,
              ctx: buildTestCtx({
                SessionKey: sessionKey,
                CommandBody: "/stop",
                RawBody: "/stop",
                CommandAuthorized: true,
              }),
            })
          : await invokeChatAbortHandler({
              handler: (options) =>
                boundary === "typed stop"
                  ? handleChatSend({
                      ...options,
                      params: { sessionKey, message: "/stop", idempotencyKey: "typed-stop" },
                    })
                  : boundary === "embedded stop"
                    ? sessionAbortHandlers["sessions.abort"]!({
                        ...options,
                        params: { key: sessionKey, runId: "parent" },
                      })
                    : handleChatAbortRequestWithLifecycle(
                        options,
                        boundary === "session cascade" ? { cascadeDescendants: true } : {},
                      ),
              context,
              request: { sessionKey, ...(boundary === "exact" ? { runId: "parent" } : {}) },
              client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
            });
      expect(signal).toHaveBeenCalledOnce();
      if (typeof result === "function") {
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("descendant cancellation was incomplete"),
          }),
        );
      } else {
        expect(result).toMatchObject({
          handled: true,
          aborted: true,
          stoppedSubagents: 2,
          failedSubagents: 2,
        });
      }
      if (typeof result === "function") {
        const error = result.mock.calls.at(-1)?.[2];
        expect(error?.message).toContain("bad:");
        expect(error?.message).toContain("second-bad:");
      }
      if (typeof result !== "function") {
        expect(
          formatAbortReplyText(result.stoppedSubagents, undefined, result.failedSubagents),
        ).toContain("Cancellation was incomplete for 2 sub-agents");
      }
      expect(await getSubagentRunByChildSessionKey(healthyKey)).toMatchObject({
        endedReason: "subagent-killed",
      });
      expect(healthyDispatch).not.toHaveBeenCalled();
      expect((await getSubagentRunByChildSessionKey(badKey))?.killIntent).toBeUndefined();
      await vi.waitFor(() => expect(badDispatch).toHaveBeenCalledOnce());
      releaseSwarmRun("bad");
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
    } finally {
      clearActiveEmbeddedRun("parent-session", embedded, sessionKey);
      releaseSwarmRun("capacity");
    }
  },
);

it.each([
  { boundary: "HTTP", queued: true },
  { boundary: "admin", queued: false },
])(
  "$boundary reports incomplete cancellation for a corrupt descendant (queued=$queued)",
  async ({ boundary, queued }) => {
    const sessionKey = "agent:main:subagent:parent";
    const badKey = "agent:broken:subagent:bad";
    const healthyKey = "agent:main:subagent:healthy";
    for (const [runId, childSessionKey, requesterSessionKey] of [
      ["parent", sessionKey, "agent:main:main"],
      ["bad", badKey, sessionKey],
      ["healthy", healthyKey, sessionKey],
    ] as const) {
      await fixture.seedRun({
        runId,
        childSessionKey,
        childAgentId: runId === "bad" ? "broken" : "main",
        requesterSessionKey,
        queued: runId === "healthy" || (runId === "bad" && queued),
        lifecycleRevision: "original-child",
      });
    }
    const badStore = path.join(fixture.stateDir, "agents/broken/sessions/sessions.json");
    await corruptChildDatabase(badStore, badKey);
    const badDispatch = vi.fn(async () => {});
    const healthyDispatch = vi.fn(async () => {});
    const survivorDispatch = vi.fn(async () => {});
    for (const [runId, start] of [
      ...(queued ? [["bad", badDispatch] as const] : []),
      ["healthy", healthyDispatch],
      ["survivor", survivorDispatch],
    ] as const) {
      fixture.queueRun({
        groupId: "admin-errors",
        runId,
        activeRunIds: ["parent"],
        start,
      });
    }
    const parentAbort = vi.fn(() => {
      expect(releaseSwarmRun("parent")).toBe(true);
      clearActiveEmbeddedRun("parent-session", parentHandle, sessionKey);
    });
    const badAbort = vi.fn();
    const parentHandle = createEmbeddedRunHandle({ runId: "parent", abort: parentAbort });
    const badHandle = createEmbeddedRunHandle({ runId: "bad", abort: badAbort });
    setActiveEmbeddedRun("parent-session", parentHandle, sessionKey);
    if (!queued) {
      setActiveEmbeddedRun("bad-session", badHandle, badKey);
    }
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const cfg = getRuntimeConfig();
      let result;
      if (boundary === "HTTP") {
        server = createServer((req, res) => {
          void handleSessionKillHttpRequest(req, res, {
            auth: {
              mode: "trusted-proxy",
              allowTailscale: false,
              trustedProxy: {
                userHeader: "x-test-user",
                allowUsers: ["operator@example.test"],
                allowLoopback: true,
              },
            },
            trustedProxies: ["127.0.0.1"],
          }).catch(() => finishFailedGatewayHttpResponse(res));
        });
        await new Promise<void>((resolve) => {
          server!.listen(0, "127.0.0.1", resolve);
        });
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/${encodeURIComponent(sessionKey)}/kill`;
        const headers = {
          "x-test-user": "operator@example.test",
          "x-forwarded-for": "203.0.113.10",
          "x-openclaw-scopes": "operator.write",
        };
        const unauthenticated = await fetch(url, {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.10" },
        });
        expect(unauthenticated.status, await unauthenticated.clone().text()).toBe(401);
        await unauthenticated.arrayBuffer();
        const wrongAgent = await fetch(
          `${url.replace(encodeURIComponent(sessionKey), encodeURIComponent(badKey))}?agentId=main`,
          {
            method: "POST",
            headers: { ...headers, "x-openclaw-scopes": "operator.admin" },
          },
        );
        expect(wrongAgent.status).toBe(400);
        await wrongAgent.arrayBuffer();
        const denied = await fetch(url, { method: "POST", headers });
        expect(denied.status).toBe(403);
        await denied.arrayBuffer();
        expect(parentAbort).not.toHaveBeenCalled();
        const response = await fetch(url, {
          method: "POST",
          headers: { ...headers, "x-openclaw-scopes": "operator.admin" },
        });
        result = { status: response.status, body: await response.json() };
      } else {
        result = await killSubagentRunAdmin({ cfg, sessionKey });
      }
      expect(parentAbort, JSON.stringify(result)).toHaveBeenCalledOnce();
      expect((await getSubagentRunByChildSessionKey(sessionKey))?.endedReason).toBe(
        "subagent-killed",
      );
      expect((await getSubagentRunByChildSessionKey(healthyKey))?.endedReason).toBe(
        "subagent-killed",
      );
      expect(healthyDispatch).not.toHaveBeenCalled();
      expect(badAbort).not.toHaveBeenCalled();
      expect((await getSubagentRunByChildSessionKey(badKey))?.killIntent).toBeUndefined();
      if (queued) {
        await vi.waitFor(() => expect(badDispatch).toHaveBeenCalledOnce());
        releaseSwarmRun("bad");
      }
      await vi.waitFor(() => expect(survivorDispatch).toHaveBeenCalledOnce());
      if (boundary === "HTTP") {
        expect(result).toMatchObject({
          status: 503,
          body: {
            ok: false,
            error: { type: "unavailable", message: expect.stringContaining("bad:") },
          },
        });
      } else {
        expect(result).toMatchObject({
          found: true,
          killed: true,
          cascadeKilled: 1,
          cascadeLabels: ["healthy"],
          error: expect.stringContaining("bad:"),
          targetState: {
            state: "terminal",
            task: { status: "cancelled", error: SUBAGENT_KILL_TASK_ERROR },
          },
        });
      }
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((error) => (error ? reject(error) : resolve()));
        });
      }
      clearActiveEmbeddedRun("parent-session", parentHandle, sessionKey);
      if (!queued) {
        clearActiveEmbeddedRun("bad-session", badHandle, badKey);
      }
    }
  },
);

it.for(["cascade native new", "RPC reset", "RPC delete"])(
  "%s does not append delayed aborted text into a new session incarnation",
  async (boundary, { signal }) => {
    const sessionKey = "agent:main:direct:incarnation";
    const sessionId = "incarnation-parent";
    const childKey = "agent:child:subagent:incarnation";
    const storePath = path.join(fixture.stateDir, "agents/main/sessions/sessions.json");
    const childStore = path.join(fixture.stateDir, "agents/child/sessions/sessions.json");
    // Seed directly; this fixture controls the cancellation/reset interleaving.
    replaceSessionEntrySync(
      { storePath, sessionKey },
      {
        sessionId,
        updatedAt: Date.now(),
        lifecycleRevision: "before-reset",
      },
    );
    replaceSessionEntrySync(
      { storePath: childStore, sessionKey: childKey },
      {
        sessionId: "incarnation-child",
        lifecycleRevision: "original-child",
        updatedAt: Date.now(),
      },
    );
    const scope = { storePath, sessionKey, sessionId, agentId: "main" };
    const parentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
    const transcriptRows = () =>
      parentDatabase.db
        .prepare(`SELECT
      (SELECT count(*) FROM session_nodes WHERE session_key = ?) AS nodes,
      (SELECT count(*) FROM session_windows WHERE session_id = ?) AS windows`)
        .get(sessionKey, sessionId);
    const seeded = appendTranscriptMessageSync(scope, {
      message: { role: "user", content: "old user turn", timestamp: Date.now() },
    });
    expect(seeded).toMatchObject({ ok: true, value: { messageId: expect.any(String) } });
    await fixture.registerRun({
      runId: "child",
      childSessionKey: childKey,
      childAgentId: "child",
      sessionEntry: loadExactSessionEntryReadOnly({
        storePath: childStore,
        sessionKey: childKey,
      })?.entry,
      requesterSessionKey: sessionKey,
      requesterTurnRunId: "parent",
      task: "child",
      expectsCompletionMessage: false,
    });
    const entered = createDeferred();
    const release = createDeferred();
    const child = (await getSubagentRunByChildSessionKey(childKey))!;
    const childTerminated = createDeferred();
    const stopObservingChild = subscribeSubagentRunChanges("persistence", () => {
      const current = subagentRuns.get(child.runId);
      if (isSameSubagentRunOwner(current, child) && current?.endedReason === "subagent-killed") {
        childTerminated.resolve();
      }
    });
    const native = boundary.endsWith("native new");
    const childHandle = createEmbeddedRunHandle();
    const childOperation = createReplyOperation({
      sessionKey: childKey,
      sessionId: "incarnation-child",
      agentId: "child",
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: childStore,
        sessionKey: childKey,
        incarnation: "incarnation-child",
        agentId: "child",
      }),
    });
    setActiveEmbeddedRun(
      "incarnation-child",
      childHandle,
      childKey,
      undefined,
      "child",
      childOperation,
    );
    const parentAdmission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    const cfg = getRuntimeConfig();
    const parent = createActiveRun(sessionKey, {
      runId: "parent",
      sessionId,
      agentId: "main",
      owner: { connId: "owner" },
    });
    parent.input.abortSignal.addEventListener("abort", () => {
      parentAdmission.release();
      operation.complete();
    });
    const context = createChatAbortContext({
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(),
    });
    registerRpcSource("parent", parent);
    context.chatRunState.getOrCreate("parent").buffer = "old delayed partial";
    // Hold only the original marker after termination, without occupying the child writer FIFO.
    const persistMarker = subagentControlSession.persistSubagentAbortedLastRun;
    let markerHeld = false;
    const markerWriter = vi
      .spyOn(subagentControlSession, "persistSubagentAbortedLastRun")
      .mockImplementation(async (params) => {
        if (!markerHeld && params.childSessionKey === childKey && params.abortedLastRun) {
          markerHeld = true;
          entered.resolve();
          await release.promise;
        }
        return await persistMarker(params);
      });
    let completed = false;
    const abort = invokeChatAbortHandler({
      handler: (options) =>
        handleChatAbortRequestWithLifecycle(
          options,
          boundary === "cascade native new" ? { cascadeDescendants: true } : {},
        ),
      context,
      request: { sessionKey, ...(boundary === "cascade native new" ? {} : { runId: "parent" }) },
      client: { connId: "owner", connect: { scopes: ["operator.read", "operator.write"] } },
    }).finally(() => {
      completed = true;
    });
    try {
      await withinTest(
        Promise.race([
          Promise.all([entered.promise, childTerminated.promise]),
          abort.then(() => {
            throw new Error("abort completed before child gate");
          }),
        ]),
        signal,
      );
      expect(parent.input.abortSignal.aborted).toBe(true);
      expect(rpcSourceTesting.has("parent")).toBe(false);
      expect((await getSubagentRunByChildSessionKey(childKey))?.endedReason).toBe(
        "subagent-killed",
      );
      // Explicit reset drains children, including native /new. Keep the original
      // abort pending on its marker publication, not on work the reset must stop.
      clearActiveEmbeddedRun("incarnation-child", childHandle, childKey);
      childOperation.complete();
      if (native) {
        const reset = await initSessionState({
          cfg,
          commandAuthorized: true,
          ctx: buildTestCtx({
            SessionKey: sessionKey,
            Body: "/new",
            RawBody: "/new",
            CommandBody: "/new",
            CommandAuthorized: true,
          }),
        });
        expect(reset.resetTriggered).toBe(true);
        expect(reset.sessionId).toBe(sessionId);
      } else {
        const method = boundary === "RPC reset" ? "sessions.reset" : "sessions.delete";
        const handler =
          method === "sessions.reset"
            ? sessionMutationHandlers[method]
            : sessionDeleteHandlers[method];
        const respond = vi.fn();
        await handler!({
          params: { key: sessionKey },
          context: context as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "lifecycle", method } as never,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ ok: true }),
          undefined,
        );
      }
      expect(completed, "lifecycle committed while original abort remains pending").toBe(false);
      const entry = loadExactSessionEntryReadOnly({ storePath, sessionKey })?.entry;
      const events = await loadTranscriptEvents(scope);
      const watermark = readSessionTranscriptWatermark(scope);
      if (boundary === "RPC delete") {
        expect(entry).toBeUndefined();
        expect(events).toEqual([]);
        expect(watermark.maxSeq).toBeNull();
        expect(transcriptRows()).toEqual({ nodes: 0, windows: 0 });
      } else {
        expect(entry).toMatchObject({ sessionId, lifecycleRevision: expect.any(String) });
        expect(entry?.lifecycleRevision).not.toBe("before-reset");
        expect(events).toContainEqual(
          expect.objectContaining({ type: "reset", reason: native ? "new" : "reset" }),
        );
        expect(
          events.findLast((event) => asOptionalRecord(event)?.type === "reset"),
        ).not.toHaveProperty("firstKeptEntryId");
      }
      release.resolve();
      const response = await abort;
      expect(response).toHaveBeenCalledWith(true, expect.objectContaining({ aborted: true }));
      expect((await getSubagentRunByChildSessionKey(childKey))?.endedReason).toBe(
        "subagent-killed",
      );
      expect(
        await loadTranscriptEvents(scope),
        "old partial must not cross the committed lifecycle boundary",
      ).toEqual(events);
      expect(readSessionTranscriptWatermark(scope)).toEqual(watermark);
      if (boundary === "RPC delete") {
        expect(transcriptRows()).toEqual({ nodes: 0, windows: 0 });
      }
    } finally {
      stopObservingChild();
      parentAdmission.release();
      operation.complete();
      release.resolve();
      markerWriter.mockRestore();
      clearActiveEmbeddedRun("incarnation-child", childHandle, childKey);
      childOperation.complete();
      await abort;
    }
  },
);

it("reports typed contention without replaying or denying an already applied Stop", async () => {
  const failure = Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  vi.spyOn(sessionUtils, "loadGatewaySessionEntryReadOnlyInWorker").mockImplementation(async () => {
    throw failure;
  });
  const sessionKey = "agent:main:main";
  const active = createActiveRun(sessionKey, { agentId: "main" });
  const context = createChatAbortContext({ sources: [["run-1", active]] });
  const respond = await invokeChatAbortHandler({
    handler: handleChatAbortRequest,
    context,
    request: { sessionKey, runId: "run-1" },
    client: { connect: { scopes: ["operator.admin"] } },
  });
  expect(active.input.abortSignal.aborted).toBe(true);
  expect(respond).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      message:
        "The server is busy. Check this turn's status before trying Stop again.\n\nSQLite transaction admission remained busy. Stopping may already have taken effect.",
      details: { errorKind: "state_contention" },
    }),
  );
});

it.each([
  new Error("database is locked: private detail"),
  new AggregateError(
    [Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })],
    "cleanup failed",
  ),
])("does not certify strings or uncertain cleanup aggregates", async (error) => {
  const context = createChatAbortContext({
    getRuntimeConfig: () => {
      throw error;
    },
  });
  await expect(
    invokeChatAbortHandler({
      handler: handleChatAbortRequest,
      context,
      request: { sessionKey: "agent:main:main", runId: "run-1" },
    }),
  ).rejects.toBe(error);
});

it.each([
  { scope: "session-wide", runId: undefined },
  { scope: "exact-run", runId: "retained-run" },
] as const)(
  "$scope Stop acknowledges cancellation while preserving raw source custody",
  async ({ runId }) => {
    vi.useFakeTimers();
    const raw = createDeferred();
    const cancelled = createDeferred();
    const source = createActiveRun("main", {
      sessionId: "main-session",
      agentId: "main",
      queued: true,
    });
    const claim = await claimSessionControllerTask(source.input, (selected) => {
      createReplyOperation({
        sessionKey: "main",
        sessionId: "main-session",
        agentId: "main",
        resetTriggered: false,
        mailboxClaim: selected,
      });
    });
    const producer = (async () => {
      try {
        await raw.promise;
      } finally {
        claim.operation?.complete();
        releaseSessionControllerClaim(claim);
      }
    })();
    source.input.abortSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    const context = createChatAbortContext({ sources: [["retained-run", source]] });
    const stopping = invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "main", ...(runId ? { runId } : {}) },
      client: { connect: { scopes: ["operator.admin"] } },
    }).then(
      (respond) => ({ respond, error: undefined }),
      (error: unknown) => ({ respond: undefined, error }),
    );
    try {
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await stopping;
      expect(outcome.error).toBeUndefined();
      expect(outcome.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ aborted: true, runIds: ["retained-run"] }),
      );
      expect(claim.released).toBe(false);
      expect(source.input.phase).toBe("claimed");
      const snapshot = createGatewayActiveWorkSnapshot({
        getChatRuns: () => 0,
        getQueuedTurns: () => 0,
        getTerminalPersistence: () => 0,
      });
      expect(snapshot.idle).toBe(false);
      expect(snapshot.counts.sessionAdmissions).toBe(1);
      expect(() =>
        createReplyOperation({
          sessionKey: "main",
          sessionId: "successor",
          resetTriggered: false,
          target: source.input.target,
        }),
      ).toThrow("already active");
    } finally {
      raw.resolve();
      await producer;
      await claim.settlement.promise;
      await stopping;
      vi.useRealTimers();
    }
  },
);

it("reports a replaced child's refusal and failed persistence while raw cleanup is pending", async () => {
  const sessionKey = "agent:main:retained-parent";
  const sessionId = "retained-parent-session";
  const runId = "retained-parent-run";
  const childKey = "agent:main:subagent:replaced-child";
  const runs = createControlRunFixture(() => fixture.stateDir);
  await runs.writeSession("parent", "original-revision", {
    sessionKey,
    defaultSessionId: sessionId,
  });
  await runs.seed(
    "original-child",
    {
      runId: "original-child-run",
      childSessionKey: childKey,
      requesterSessionKey: sessionKey,
      requesterTurnRunId: runId,
      requesterDisplayKey: sessionKey,
      task: "retain the replacement child",
      collect: true,
      queued: true,
    },
    "original-revision",
  );
  const childSession = loadSessionEntry({ agentId: "main", sessionKey: childKey });
  const replacement = {
    ...childSession,
    sessionId: "replacement-child-session",
    lifecycleRevision: "replacement-revision",
    updatedAt: Date.now(),
  };
  await replaceSessionEntry({ agentId: "main", sessionKey: childKey }, replacement);
  const parent = createActiveRun(sessionKey, { runId, sessionId, agentId: "main" });
  const raw = createDeferred();
  trackSessionControllerSourceWork(parent.input, raw.promise);
  const terminalWrite = createDeferred();
  void terminalWrite.promise.catch(() => {});
  parent.adapter.projectSessionTerminalPersistence = terminalWrite.promise;
  const context = createChatAbortContext({ getRuntimeConfig, sources: new Map([[runId, parent]]) });
  const childrenStopped = createDeferred();
  const abortDescendants = chatAbortDescendants.abortControlledSubagents;
  const observed = vi
    .spyOn(chatAbortDescendants, "abortControlledSubagents")
    .mockImplementation(async (params) => {
      const result = await abortDescendants(params);
      childrenStopped.resolve();
      return result;
    });
  const sourceSettled = vi.fn();
  void parent.input.settlement.promise.then(sourceSettled);
  const respond = vi.fn();
  vi.useFakeTimers();
  const stopping = invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request: { sessionKey, runId },
    client: { connect: { scopes: ["operator.admin"] } },
    respond,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await childrenStopped.promise;
    expect(parent.input.abortSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(respond).not.toHaveBeenCalled();
    terminalWrite.reject(new Error("Original parent terminal write failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await stopping).toBeUndefined();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringMatching(
            /Parent run stopped, but descendant cancellation was incomplete: .*original session incarnation is unresolved or changed/,
          ),
        }),
      ],
    ]);
    const message: unknown = respond.mock.calls[0]?.[2]?.message;
    expect(message).toContain("Original parent terminal write failed");
    expect(message).not.toContain("cleanup is still pending");
    expect(sourceSettled).not.toHaveBeenCalled();
    expect(rpcSourceTesting.get(runId)).toBe(parent);
    expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toEqual(replacement);
  } finally {
    parent.adapter.projectSessionTerminalPersistence = undefined;
    raw.resolve();
    terminalWrite.resolve();
    await parent.input.settlement.promise;
    await stopping;
    observed.mockRestore();
    vi.useRealTimers();
  }
  expect(sourceSettled).toHaveBeenCalledOnce();
  expect(rpcSourceTesting.get(runId)).toBeUndefined();
});
