import { afterEach, describe, expect, it, vi } from "vitest";
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
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const resumeChat = vi.hoisted(() => vi.fn());
vi.mock("./chat-send-handler.js", () => ({ handleSessionGoalResumeChat: resumeChat }));

const sessionKey = "agent:main:goal-controls";
const sessionId = "goal-controls-session";
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };

function initialGoal(): SessionGoal {
  return {
    schemaVersion: 1,
    id: "original-goal",
    objective: "Finish the release checklist",
    status: "paused",
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokensUsed: 0,
    continuationTurns: 0,
  };
}

async function seedSession(patch: Partial<SessionEntry> = {}) {
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId,
      updatedAt: 1,
      lifecycleRevision: "goal-controls-lifecycle",
      goal: initialGoal(),
      ...patch,
    },
  );
}

function client(scopes = ["operator.write"], profileId?: string): GatewayClient {
  return {
    connId: "goal-controls-client",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: "Reader",
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
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
  if (options.direct) {
    await sessionGoalHandlers[handlerOptions.req.method]!(handlerOptions);
  } else {
    await handleGatewayRequest(handlerOptions);
  }
  if (!options.sessionMutationAuthorization) {
    assertNoRetainedSessionSharingReads();
  }
  return respond;
}

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  resumeChat.mockReset();
});

describe("typed Goal management RPCs", () => {
  it.each([
    { outcome: "success", patch: {}, succeeds: true },
    { outcome: "early return", patch: { sessionId: "replaced-session" }, succeeds: false },
    { outcome: "operation error", patch: { goalId: "replaced-goal" }, succeeds: false },
  ])("releases directly acquired authorization after $outcome", async ({ patch, succeeds }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
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
      try {
        const respond = await invoke(operation("complete", patch), { direct: true });
        expect(respond).toHaveBeenCalledWith(
          succeeds,
          succeeds
            ? expect.objectContaining({ goal: expect.objectContaining({ status: "complete" }) })
            : undefined,
          succeeds ? undefined : expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(resolved).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        release();
      }
    });
  });

  it("leaves borrowed authorization with its dispatch owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
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
      try {
        const respond = await invoke(request, {
          direct: true,
          sessionMutationAuthorization: { ...resolved.authorization, release },
        });
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(release).not.toHaveBeenCalled();
        expect(() => resolved.authorization?.assertCurrent()).not.toThrow();
      } finally {
        release();
      }
      assertNoRetainedSessionSharingReads();
    });
  });

  it("edits literal objectives in the writer without chat rows and rejects a changed retry", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
      await seedSession();
      const objective = "clear the backlog\n/goal pause is part of the objective";
      const request = operation("edit", { objective });
      const commitGuard = vi.fn();
      const sql = observeHostDataSql();
      try {
        const first = await invoke(request, { commitGuard });
        expect(first).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            operationId: request.operationId,
            status: "updated",
            goal: expect.objectContaining({ objective, status: "paused" }),
          }),
          undefined,
        );
        const replay = await invoke(request, { commitGuard });
        expect(replay).toHaveBeenCalledWith(
          true,
          { ...first.mock.calls[0]?.[1], replayed: true },
          undefined,
        );
        const conflict = await invoke(
          { ...request, objective: "different objective" },
          { commitGuard },
        );
        expect(conflict).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: { code: "GOAL_OPERATION_REJECTED", reason: "operation-conflict" },
          }),
        );
        expect(commitGuard).toHaveBeenCalled();
        expect(sql.queries.filter((query) => /\bsession_goal_operations\b/i.test(query))).toEqual(
          [],
        );
      } finally {
        sql.restore();
      }
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal?.objective).toBe(objective);
      expect(await loadTranscriptEvents({ agentId: "main", sessionKey, sessionId })).toEqual([]);
      expect(resumeChat).not.toHaveBeenCalled();
    });
  });

  it("replays a clear without deleting a replacement Goal", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
      await seedSession();
      const request = operation("clear");
      const first = await invoke(request, { method: "sessions.goal.clear" });
      expect(first).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "cleared" }),
        undefined,
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toBeUndefined();
      await seedSession({ goal: { ...initialGoal(), id: "replacement-goal" } });
      const replay = await invoke(request, { method: "sessions.goal.clear" });
      expect(replay).toHaveBeenCalledWith(
        true,
        { ...first.mock.calls[0]?.[1], replayed: true },
        undefined,
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal?.id).toBe("replacement-goal");
    });
  });

  it.each(["sessions.goal.update", "sessions.goal.clear"] as const)(
    "%s requires write scope and session participation before mutation or continuation",
    async (method) => {
      await withOpenClawTestState(
        { scenario: "minimal", prepareProfileCatalog: true },
        async () => {
          setRuntimeConfigSnapshot(cfg);
          const owner = ensureProfileForEmail("goal-owner@example.test");
          const viewer = ensureProfileForEmail("goal-viewer@example.test");
          await seedSession({
            visibility: "read-only",
            createdActor: { type: "human", source: "profile", id: owner.id },
          });
          const request = operation(method === "sessions.goal.clear" ? "clear" : "resume");
          const readOnly = await invoke(request, {
            method,
            client: client(["operator.read"], owner.id),
          });
          expect(readOnly).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              message: "missing scope: operator.write",
            }),
          );
          const notParticipant = await invoke(request, {
            method,
            client: client(["operator.write"], viewer.id),
          });
          expect(notParticipant).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
            }),
          );
          expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toEqual(initialGoal());
          expect(resumeChat).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each([
    { name: "session generation", patch: { sessionId: "replaced-session" } },
    { name: "Goal identity", patch: { goalId: "replaced-goal" } },
    { name: "agent owner", patch: { agentId: "other" } },
  ])("rejects stale $name without changing state", async ({ patch }) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
      await seedSession();
      const result = await invoke(operation("pause", patch));
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toEqual(initialGoal());
      expect(resumeChat).not.toHaveBeenCalled();
    });
  });

  it("rejects a revoked caller without persisting a Goal change or receipt", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
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
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "caller closed" }),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toEqual(initialGoal());
      const retry = await invoke(request);
      expect(retry).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          goal: expect.objectContaining({ status: "complete" }),
        }),
        undefined,
      );
    });
  });

  it("rejects a plugin caller that does not own the session", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
      await seedSession({ pluginOwnerId: "owning-plugin" });
      const pluginClient: GatewayClient = {
        ...client(),
        internal: { pluginRuntimeOwnerId: "other-plugin" },
      };
      const result = await invoke(operation("complete"), { client: pluginClient });
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("did not create it"),
        }),
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toEqual(initialGoal());
    });
  });

  it("does not activate a Goal before continuation admission succeeds", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot(cfg);
      await seedSession();
      resumeChat.mockImplementation(async (options: GatewayRequestHandlerOptions) => {
        options.respond(false, undefined, { code: "UNAVAILABLE", message: "session busy" });
      });
      const result = await invoke(operation("resume"));
      expect(result).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: "session busy" }),
      );
      expect(resumeChat).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.goal).toEqual(initialGoal());
      expect(await loadTranscriptEvents({ agentId: "main", sessionKey, sessionId })).toEqual([]);
    });
  });
});
