import { existsSync, renameSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
} from "../../config/sessions/session-sharing-store.js";
import {
  addSessionSuggestion,
  listSessionSuggestions,
} from "../../config/sessions/session-suggestion-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

const methods = [
  "session.members.add",
  "session.members.remove",
  "session.suggestions.add",
  "session.suggestions.resolve",
  "sessions.assignOwner",
] as const;
type MetadataMethod = (typeof methods)[number];
const handlers: GatewayRequestHandlers = {
  ...sessionMutationHandlers,
  ...sessionSharingHandlers,
  ...sessionSuggestionHandlers,
};

afterEach(() => flushPendingSessionsChangedEvents());

async function seedMetadata(state: OpenClawTestState) {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const other = ensureProfileForEmail("metadata-other@example.test");
  const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:metadata" };
  await upsertSessionEntryCore(scope, {
    sessionId: "metadata",
    updatedAt: 1,
    visibility: "suggest",
    createdActor: { type: "human", source: "profile", id: owner.id },
  });
  const database = openOpenClawAgentDatabase(scope);
  return { owner, other, scope, database, options: { ...scope, path: database.path } };
}

function invoke(
  method: MetadataMethod,
  params: Record<string, unknown>,
  client: GatewayClient,
  context: GatewayRequestContext,
) {
  const authorization = resolveSessionMutationAuthorization({
    method,
    requestParams: params,
    client,
    context,
  });
  expect(authorization.error).toBeNull();
  const respond = vi.fn<RespondFn>();
  const errors: unknown[] = [];
  const done = (async () => {
    try {
      await handlers[method]!({
        req: { type: "req", id: "metadata-admission", method, params },
        params,
        client,
        context,
        respond,
        sessionMutationAuthorization: authorization.authorization,
        isWebchatConnect: () => false,
      });
    } catch (error) {
      errors.push(error);
    }
  })();
  return { done, respond, errors };
}

describe("session metadata writer admission", () => {
  it.each(["shared", "read-only", "suggest"] as const)(
    "preserves write-scoped viewer assignment for a %s session",
    async (visibility) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { scope, owner, other } = await seedMetadata(state);
        replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, visibility });
        const viewer = identifiedClient(other.id);
        const target = resolveSessionSharingTarget({
          cfg: {},
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
        })!;
        expect(resolveSessionSharingRole({ cfg: {}, client: viewer, target })).toBe("viewer");
        const request = invoke(
          "sessions.assignOwner",
          { key: scope.sessionKey, owner: { type: "human", id: other.id } },
          viewer,
          sessionSharingTestContext(vi.fn()),
        );
        await request.done;
        expect(request.errors).toEqual([]);
        expect(request.respond.mock.calls[0]?.[0]).toBe(true);
        expect(loadSessionEntry(scope)?.owner?.actor).toEqual({ type: "human", id: other.id });
        const current = resolveSessionSharingTarget({
          cfg: {},
          sessionKey: scope.sessionKey,
          agentId: scope.agentId,
        })!;
        expect(current.entry.createdActor?.id).toBe(owner.id);
        expect(resolveSessionSharingRole({ cfg: {}, client: viewer, target: current })).toBe(
          "viewer",
        );
      });
    },
  );

  it.each(["sessions.assignOwner", "session.members.add", "session.suggestions.add"] as const)(
    "rejects %s before recreating its retired store after admission waits",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { scope, owner, other, options } = await seedMetadata(state);
        const replacement = { ...scope, storePath: state.path("replacement-store.sqlite") };
        const retired = { ...scope, storePath: state.path("retired-store.sqlite") };
        await upsertSessionEntryCore(replacement, { ...loadSessionEntry(scope)! });
        let cfg: OpenClawConfig = {};
        const context = sessionSharingTestContext(vi.fn());
        context.getRuntimeConfig = () => cfg;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(options, async () => {
          entered.resolve();
          await release.promise;
          cfg = { session: { store: replacement.storePath } };
          expect(disposeOpenClawAgentDatabaseByPath(options.path, { env: state.env })).toBe(true);
          renameSync(options.path, retired.storePath);
        });
        await entered.promise;
        const params =
          method === "sessions.assignOwner"
            ? { key: scope.sessionKey, owner: { type: "human", id: other.id } }
            : method === "session.members.add"
              ? { sessionKey: scope.sessionKey, identityId: other.id }
              : { sessionKey: scope.sessionKey, text: "must not follow a replacement store" };
        const request = invoke(method, params, identifiedClient(owner.id), context);
        try {
          await setImmediate();
          expect(request.respond).not.toHaveBeenCalled();
          release.resolve();
          await Promise.all([reservation, request.done]);
          expect(request.respond.mock.calls.some(([ok]) => ok)).toBe(false);
          expect(request.errors.length === 1 || request.respond.mock.calls[0]?.[0] === false).toBe(
            true,
          );
          expect(existsSync(options.path)).toBe(false);
          for (const target of [retired, replacement]) {
            expect(loadSessionEntry(target)?.owner).toBeUndefined();
            expect(listSessionMembers(target)).toEqual([]);
            expect(listSessionSuggestions(target)).toEqual([]);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([reservation, request.done]);
        }
      });
    },
  );

  it.each(methods)("keeps %s behind the native writer reservation", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await seedMetadata(state);
      const { scope, owner, other, options } = fixture;
      if (method === "session.members.remove") {
        addSessionMember(scope, { identityId: other.id, addedBy: owner.id });
      }
      if (method === "session.suggestions.resolve") {
        addSessionSuggestion(scope, {
          id: "pending",
          authorId: owner.id,
          text: "synthetic suggestion",
        });
      }
      const params =
        method === "sessions.assignOwner"
          ? { key: scope.sessionKey, owner: { type: "human", id: other.id } }
          : method === "session.suggestions.resolve"
            ? { sessionKey: scope.sessionKey, id: "pending", resolution: "dismiss" }
            : method === "session.suggestions.add"
              ? { sessionKey: scope.sessionKey, text: "synthetic suggestion" }
              : { sessionKey: scope.sessionKey, identityId: other.id };
      const read = () => ({
        owner: loadSessionEntry(scope)?.owner,
        members: listSessionMembers(scope),
        suggestions: listSessionSuggestions(scope),
      });
      const before = structuredClone(read());
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const reservation = runOpenClawAgentWorkerWrite(options, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const request = invoke(
        method,
        params,
        identifiedClient(owner.id),
        sessionSharingTestContext(vi.fn()),
      );
      try {
        await setImmediate();
        expect(request.respond).not.toHaveBeenCalled();
        expect(read()).toEqual(before);
        release.resolve();
        await Promise.all([reservation, request.done]);
        expect(request.errors).toEqual([]);
        expect(request.respond.mock.calls[0]?.[0]).toBe(true);
        if (method === "sessions.assignOwner") {
          expect(loadSessionEntry(scope)?.owner?.actor).toEqual({ type: "human", id: other.id });
        } else if (method.startsWith("session.members")) {
          expect(listSessionMembers(scope).map((member) => member.identityId)).toEqual(
            method === "session.members.add" ? [other.id] : [],
          );
        } else {
          expect(listSessionSuggestions(scope)).toEqual([
            expect.objectContaining({
              state: method === "session.suggestions.add" ? "pending" : "dismissed",
            }),
          ]);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([reservation, request.done]);
      }
    });
  });

  it.each(["owner", "visibility", "config"] as const)(
    "rejects a mutation after %s authority changes in the earlier writer",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { scope, owner, other, options } = await seedMetadata(state);
        let cfg: OpenClawConfig =
          kind === "owner" ? { agents: { entries: { main: {}, research: {} } } } : {};
        const context = sessionSharingTestContext(vi.fn());
        context.getRuntimeConfig = () => cfg;
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(options, async () => {
          entered.resolve();
          await release.promise;
          if (kind === "owner") {
            cfg = { agents: { entries: { main: {} } } };
            expect(cfg.agents?.entries).not.toHaveProperty("research");
          } else if (kind === "config") {
            cfg = {
              gateway: {
                roles: {
                  default: "viewer",
                  definitions: {
                    viewer: {
                      sessions: { others: "view" },
                      agents: "*",
                      scopes: ["operator.read", "operator.write"],
                    },
                  },
                },
              },
            };
          } else {
            const entry = loadSessionEntry(scope)!;
            replaceSessionEntrySync(scope, {
              ...entry,
              visibility: "draft",
            });
            expect(loadSessionEntry(scope)?.visibility).toBe("draft");
          }
        });
        await entered.promise;
        const request = invoke(
          kind === "owner" ? "sessions.assignOwner" : "session.suggestions.add",
          kind === "owner"
            ? { key: scope.sessionKey, owner: { type: "agent", id: "research" } }
            : { sessionKey: scope.sessionKey, text: "must not persist after revocation" },
          identifiedClient(kind === "config" ? other.id : owner.id),
          context,
        );
        try {
          await setImmediate();
          release.resolve();
          await Promise.all([reservation, request.done]);
          expect(request.respond.mock.calls.some(([ok]) => ok)).toBe(false);
          expect(request.errors.length === 1 || request.respond.mock.calls[0]?.[0] === false).toBe(
            true,
          );
          expect(listSessionMembers(scope)).toEqual([]);
          expect(listSessionSuggestions(scope)).toEqual([]);
          if (kind === "owner") {
            expect(loadSessionEntry(scope)?.owner).toBeUndefined();
          }
        } finally {
          release.resolve();
          await Promise.allSettled([reservation, request.done]);
        }
      });
    },
  );
});
