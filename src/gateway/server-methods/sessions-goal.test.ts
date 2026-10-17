import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { SessionEntry, SessionGoal } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import * as sessionAuthorization from "../session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionGoalHandlers } from "./sessions-goal.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

function expectSuccess(respond: ReturnType<typeof vi.fn>, result: unknown) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}

function expectGoal(respond: ReturnType<typeof vi.fn>, goal: Partial<SessionGoal>, extra = {}) {
  expectSuccess(
    respond,
    expect.objectContaining({ ...extra, goal: expect.objectContaining(goal) }),
  );
}

const resumeChat = vi.hoisted(() => vi.fn());
vi.mock("./chat-send-handler.js", () => ({ handleSessionGoalResumeChat: resumeChat }));

const sessionKey = "agent:main:goal-controls";
const sessionId = "goal-controls-session";
const scope = { agentId: "main", sessionKey };
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };

function withGoalState(run: () => Promise<void>, prepareProfileCatalog = true) {
  return withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog }, async () => {
    setRuntimeConfigSnapshot(cfg);
    await run();
  });
}

function readGoal() {
  return loadSessionEntry(scope)?.goal;
}

const initialGoal = (): SessionGoal => ({
  schemaVersion: 1,
  id: "original-goal",
  objective: "Finish the release checklist",
  status: "paused",
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 0,
  continuationTurns: 0,
});

async function seedSession(patch: Partial<SessionEntry> = {}) {
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    lifecycleRevision: "goal-controls-lifecycle",
    goal: initialGoal(),
    ...patch,
  });
}

function client(scopes = ["operator.write"], profileId?: string): GatewayClient {
  const requestClient = createSessionMutationTestClient(profileId);
  requestClient.connId = "goal-controls-client";
  requestClient.connect.scopes = scopes;
  delete requestClient.authenticatedUserId;
  if (requestClient.authenticatedUserProfile) {
    requestClient.authenticatedUserProfile.displayName = "Reader";
  }
  return requestClient;
}

function operation(action: string, extra: Record<string, unknown> = {}) {
  return {
    sessionKey,
    sessionId,
    goalId: "original-goal",
    operationId: "goal-operation",
    issuedAtMs: Date.now(),
    ...(action !== "clear" ? { action } : {}),
    ...extra,
  };
}

async function invoke(
  request: Record<string, unknown>,
  options: {
    method?: "sessions.goal.update" | "sessions.goal.clear";
    client?: GatewayClient;
    commitGuard?: () => void;
    direct?: boolean;
    sessionMutationAuthorization?: GatewayRequestHandlerOptions["sessionMutationAuthorization"];
  } = {},
) {
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const handlerOptions: GatewayRequestHandlerOptions = {
    req: {
      type: "req",
      id: "goal-rpc",
      method: options.method ?? "sessions.goal.update",
      params: request,
    },
    respond,
    context,
    client: options.client ?? client(),
    params: request,
    isWebchatConnect: () => true,
    sessionMutationAuthorization: options.sessionMutationAuthorization,
    ...(options.commitGuard ? { sessionMutationCommitGuard: options.commitGuard } : {}),
  };
  const handler = options.direct
    ? sessionGoalHandlers[handlerOptions.req.method]!
    : handleGatewayRequest;
  await handler(handlerOptions);
  if (!options.sessionMutationAuthorization) {
    assertNoRetainedSessionSharingReads();
  }
  return respond;
}

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  resumeChat.mockReset();
});

it.each([
  { outcome: "success", patch: {}, succeeds: true },
  { outcome: "early return", patch: { sessionId: "replaced-session" }, succeeds: false },
  { outcome: "operation error", patch: { goalId: "replaced-goal" }, succeeds: false },
])("releases directly acquired authorization after $outcome", ({ patch, succeeds }) =>
  withGoalState(async () => {
    await seedSession();
    const resolve = sessionAuthorization.resolveSessionMutationAuthorizationAsync;
    const release = vi.fn<() => void>();
    using resolved = vi
      .spyOn(sessionAuthorization, "resolveSessionMutationAuthorizationAsync")
      .mockImplementation(async (request) => {
        const result = await resolve(request);
        if (!result.authorization?.release) {
          throw new Error("Expected a retained Goal authorization");
        }
        release.mockImplementation(result.authorization.release);
        return { ...result, authorization: { ...result.authorization, release } };
      });
    using _ = { [Symbol.dispose]: release };
    const respond = await invoke(operation("complete", patch), { direct: true });
    if (succeeds) {
      expectGoal(respond, { status: "complete" });
    } else {
      expectFailure(respond, { code: "INVALID_REQUEST" });
    }
    expect(resolved).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  }, false),
);

it("leaves borrowed authorization with its dispatch owner", () =>
  withGoalState(async () => {
    await seedSession();
    const request = operation("complete");
    const resolved = await sessionAuthorization.resolveSessionMutationAuthorizationAsync({
      client: client(),
      method: "sessions.goal.update",
      requestParams: request,
      context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
    });
    if (!resolved.authorization?.release) {
      throw new Error("Expected a retained Goal authorization");
    }
    const release = vi.fn(resolved.authorization.release);
    {
      using _ = { [Symbol.dispose]: release };
      const respond = await invoke(request, {
        direct: true,
        sessionMutationAuthorization: { ...resolved.authorization, release },
      });
      expectSuccess(respond, expect.any(Object));
      expect(release).not.toHaveBeenCalled();
      expect(() => resolved.authorization?.assertCurrent()).not.toThrow();
    }
    assertNoRetainedSessionSharingReads();
  }, false));

it("edits literal objectives in the writer without chat rows and rejects a changed retry", () =>
  withGoalState(async () => {
    await seedSession();
    const objective = "clear the backlog\n/goal pause is part of the objective";
    const request = operation("edit", { objective });
    const commitGuard = vi.fn();
    const sql = observeHostDataSql();
    {
      using _ = { [Symbol.dispose]: sql.restore };
      const first = await invoke(request, { commitGuard });
      expectGoal(
        first,
        { objective, status: "paused" },
        {
          operationId: request.operationId,
          status: "updated",
        },
      );
      const replay = await invoke(request, { commitGuard });
      expectSuccess(replay, { ...first.mock.calls[0]?.[1], replayed: true });
      const conflict = await invoke(
        { ...request, objective: "different objective" },
        { commitGuard },
      );
      expectFailure(conflict, {
        details: { code: "GOAL_OPERATION_REJECTED", reason: "operation-conflict" },
      });
      expect(commitGuard).toHaveBeenCalled();
      expect(sql.queries.filter((query) => /\bsession_goal_operations\b/i.test(query))).toEqual([]);
    }
    expect(readGoal()?.objective).toBe(objective);
    expect(await loadTranscriptEvents({ ...scope, sessionId })).toEqual([]);
    expect(resumeChat).not.toHaveBeenCalled();
  }));

it("replays a clear without deleting a replacement Goal", () =>
  withGoalState(async () => {
    await seedSession();
    const request = operation("clear");
    const first = await invoke(request, { method: "sessions.goal.clear" });
    expectSuccess(first, expect.objectContaining({ status: "cleared" }));
    expect(readGoal()).toBeUndefined();
    await seedSession({ goal: { ...initialGoal(), id: "replacement-goal" } });
    const replay = await invoke(request, { method: "sessions.goal.clear" });
    expectSuccess(replay, { ...first.mock.calls[0]?.[1], replayed: true });
    expect(readGoal()?.id).toBe("replacement-goal");
  }));

it.each(["sessions.goal.update", "sessions.goal.clear"] as const)(
  "%s requires write scope and session participation before mutation or continuation",
  (method) =>
    withGoalState(async () => {
      const owner = ensureProfileForEmail("goal-owner@example.test");
      const viewer = ensureProfileForEmail("goal-viewer@example.test");
      await seedSession({
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const request = operation(method === "sessions.goal.clear" ? "clear" : "resume");
      for (const [requestClient, error] of [
        [
          client(["operator.read"], owner.id),
          { code: "FORBIDDEN", message: "missing scope: operator.write" },
        ],
        [
          client(["operator.write"], viewer.id),
          {
            details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
          },
        ],
      ] as const) {
        expectFailure(await invoke(request, { method, client: requestClient }), error);
      }
      expect(readGoal()).toEqual(initialGoal());
      expect(resumeChat).not.toHaveBeenCalled();
    }),
);

it.each([
  { name: "session generation", patch: { sessionId: "replaced-session" } },
  { name: "Goal identity", patch: { goalId: "replaced-goal" } },
  { name: "agent owner", patch: { agentId: "other" } },
])("rejects stale $name without changing state", ({ patch }) =>
  withGoalState(async () => {
    await seedSession();
    const result = await invoke(operation("pause", patch));
    expectFailure(result, { code: "INVALID_REQUEST" });
    expect(readGoal()).toEqual(initialGoal());
    expect(resumeChat).not.toHaveBeenCalled();
  }),
);

it("rejects a revoked caller without persisting a Goal change or receipt", () =>
  withGoalState(async () => {
    await seedSession();
    let checks = 0;
    const request = operation("complete");
    const result = await invoke(request, {
      commitGuard: () => {
        if (++checks === 2) {
          throw new SessionMutationAuthorizationChangedError({
            code: "FORBIDDEN",
            message: "caller closed",
          });
        }
      },
    });
    expectFailure(result, { message: "caller closed" });
    expect(readGoal()).toEqual(initialGoal());
    const retry = await invoke(request);
    expectGoal(retry, { status: "complete" });
  }));

it("rejects a plugin caller that does not own the session", () =>
  withGoalState(async () => {
    await seedSession({ pluginOwnerId: "owning-plugin" });
    const pluginClient: GatewayClient = {
      ...client(),
      internal: { pluginRuntimeOwnerId: "other-plugin" },
    };
    const result = await invoke(operation("complete"), { client: pluginClient });
    expectFailure(result, {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("did not create it"),
    });
    expect(readGoal()).toEqual(initialGoal());
  }));

it("does not activate a Goal before continuation admission succeeds", () =>
  withGoalState(async () => {
    await seedSession();
    resumeChat.mockImplementation(async (options: GatewayRequestHandlerOptions) => {
      options.respond(false, undefined, { code: "UNAVAILABLE", message: "session busy" });
    });
    const result = await invoke(operation("resume"));
    expectFailure(result, { message: "session busy" });
    expect(resumeChat).toHaveBeenCalledOnce();
    expect(readGoal()).toEqual(initialGoal());
    expect(await loadTranscriptEvents({ ...scope, sessionId })).toEqual([]);
  }));
