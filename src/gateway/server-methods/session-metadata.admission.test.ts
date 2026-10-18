import { existsSync, renameSync } from "node:fs";
import { backup } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionSuggestionInWorker as addSessionSuggestion } from "../../config/sessions/session-metadata-write.async.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
} from "../../config/sessions/session-sharing-store.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTargetAsync,
} from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
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
  setRuntimeConfigSnapshot({});
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

async function reserve(options: Fixture["options"], beforeRelease = () => {}) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const reservation = runOpenClawAgentWorkerWrite(options, async () => {
    entered.resolve();
    await release.promise;
    beforeRelease();
  });
  await entered.promise;
  return { release, reservation };
}

function expectRejected(request: ReturnType<typeof invoke>) {
  expect(request.respond.mock.calls.some(([ok]) => ok)).toBe(false);
  expect(request.errors.length === 1 || request.respond.mock.calls[0]?.[0] === false).toBe(true);
}

async function sharingRole(scope: Fixture["scope"], viewer: GatewayClient, identityId: string) {
  const target = (await resolveSessionSharingTargetAsync({
    cfg: {},
    sessionKey: scope.sessionKey,
    agentId: scope.agentId,
  }))!;
  const { members } = await readSessionMembersInWorker(scope);
  const role = resolveSessionSharingRole({
    cfg: {},
    client: viewer,
    target,
    isMember: members.some((member) => member.identityId === identityId),
  });
  return { target, role };
}

type Fixture = Awaited<ReturnType<typeof seedMetadata>>;

async function withMetadata(run: (fixture: Fixture, state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) =>
    run(await seedMetadata(state), state),
  );
}

async function readContext(getConfig?: () => OpenClawConfig) {
  const context = sessionSharingTestContext(vi.fn());
  if (getConfig) {
    context.getRuntimeConfig = getConfig;
    setRuntimeConfigSnapshot(getConfig());
  }
  await initializeSessionReadContext(context);
  return context;
}

function paramsFor(method: MetadataMethod, key: string, identityId: string) {
  if (method === "sessions.assignOwner") {
    return { key, owner: { type: "human", id: identityId } };
  }
  if (method === "session.suggestions.resolve") {
    return { sessionKey: key, id: "pending", resolution: "dismiss" };
  }
  if (method === "session.suggestions.add") {
    return { sessionKey: key, text: "synthetic suggestion" };
  }
  return { sessionKey: key, identityId };
}

it.each(["shared", "read-only", "suggest"] as const)(
  "preserves write-scoped viewer assignment for a %s session",
  async (visibility) => {
    await withMetadata(async ({ scope, owner, other }) => {
      replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, visibility });
      const viewer = identifiedClient(other.id);
      expect((await sharingRole(scope, viewer, other.id)).role).toBe("viewer");
      const context = await readContext();
      const request = invoke(
        "sessions.assignOwner",
        { key: scope.sessionKey, owner: { type: "human", id: other.id } },
        viewer,
        context,
      );
      await request.done;
      expect(request.errors).toEqual([]);
      expect(request.respond.mock.calls[0]?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.owner?.actor).toEqual({ type: "human", id: other.id });
      const current = await sharingRole(scope, viewer, other.id);
      expect(current.target.entry.createdActor?.id).toBe(owner.id);
      expect(current.role).toBe("viewer");
    });
  },
);

it.each([
  ["commit", "session.members.add"],
  ["commit", "session.members.remove"],
  ["commit", "session.suggestions.add"],
  ["commit", "session.suggestions.resolve"],
  ["commit", "sessions.assignOwner"],
  ["retired", "sessions.assignOwner"],
  ["retired", "session.members.add"],
  ["retired", "session.suggestions.add"],
  ["owner", "sessions.assignOwner"],
  ["visibility", "session.suggestions.add"],
  ["config", "session.suggestions.add"],
] as const)("%s: %s respects writer admission", async (kind, method) => {
  await withMetadata(async ({ scope, owner, other, database, options }, state) => {
    const replacement = { ...scope, storePath: state.path("replacement-store.sqlite") };
    const retired = { ...scope, storePath: state.path("retired-store.sqlite") };
    const originalEntry = loadSessionEntry(scope)!;
    if (kind === "retired") {
      // This copy joins discovery only after the config switch.
      await backup(requireNativeSqliteDatabase(database.db), replacement.storePath);
    }
    if (method === "session.members.remove") {
      await addSessionMember(scope, { identityId: other.id, addedBy: owner.id });
    }
    if (method === "session.suggestions.resolve") {
      await addSessionSuggestion(scope, {
        id: "pending",
        authorId: owner.id,
        text: "synthetic suggestion",
      });
    }
    const read = async () => ({
      owner: loadSessionEntry(scope)?.owner,
      members: (await readSessionMembersInWorker(scope)).members,
      suggestions: await listSessionSuggestions(scope),
    });
    const before = kind === "commit" ? structuredClone(await read()) : undefined;
    let cfg: OpenClawConfig =
      kind === "owner"
        ? { agents: { entries: { main: {}, research: {} } } }
        : kind === "retired"
          ? { session: { store: options.path } }
          : {};
    const context = await readContext(kind === "commit" ? undefined : () => cfg);
    const { release, reservation } = await reserve(options, () => {
      if (kind === "owner") {
        cfg = { agents: { entries: { main: {} } } };
        setRuntimeConfigSnapshot(cfg);
        expect(cfg.agents?.entries).not.toHaveProperty("research");
      } else if (kind === "config") {
        const viewer = {
          sessions: { others: "view" as const },
          agents: "*" as const,
          scopes: ["operator.read" as const, "operator.write" as const],
        };
        cfg = { gateway: { roles: { default: "viewer", definitions: { viewer } } } };
        setRuntimeConfigSnapshot(cfg);
      } else if (kind === "visibility") {
        replaceSessionEntrySync(scope, { ...loadSessionEntry(scope)!, visibility: "draft" });
        expect(loadSessionEntry(scope)?.visibility).toBe("draft");
      }
    });
    const params =
      kind === "owner"
        ? { key: scope.sessionKey, owner: { type: "agent", id: "research" } }
        : paramsFor(method, scope.sessionKey, other.id);
    const client = identifiedClient(kind === "config" ? other.id : owner.id);
    const request = invoke(method, params, client, context);
    try {
      await setImmediate();
      expect(request.respond).not.toHaveBeenCalled();
      if (kind === "commit") {
        expect(await read()).toEqual(before);
      } else if (kind === "retired") {
        // Retiring externally must not inherit the waiting mutation's writer.
        cfg = { session: { store: replacement.storePath } };
        setRuntimeConfigSnapshot(cfg);
        expect(await disposeOpenClawAgentDatabaseByPath(options.path, { env: state.env })).toBe(
          true,
        );
        renameSync(options.path, retired.storePath);
      }
      release.resolve();
      await Promise.all([reservation, request.done]);
      if (kind === "commit") {
        expect(request.errors).toEqual([]);
        expect(request.respond.mock.calls[0]?.[0]).toBe(true);
        if (method === "sessions.assignOwner") {
          expect(loadSessionEntry(scope)?.owner?.actor).toEqual({ type: "human", id: other.id });
        } else if (method.startsWith("session.members")) {
          expect(
            (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
          ).toEqual(method === "session.members.add" ? [other.id] : []);
        } else {
          expect(await listSessionSuggestions(scope)).toEqual([
            expect.objectContaining({
              state: method === "session.suggestions.add" ? "pending" : "dismissed",
            }),
          ]);
        }
      } else {
        expectRejected(request);
        if (kind === "retired") {
          expect(existsSync(options.path)).toBe(false);
          for (const target of [retired, replacement]) {
            expect(loadSessionEntry(target)).toEqual(originalEntry);
            expect((await readSessionMembersInWorker(target)).members).toEqual([]);
            expect(await listSessionSuggestions(target)).toEqual([]);
          }
        } else {
          expect((await readSessionMembersInWorker(scope)).members).toEqual([]);
          expect(await listSessionSuggestions(scope)).toEqual([]);
          if (kind === "owner") {
            expect(loadSessionEntry(scope)?.owner).toBeUndefined();
          }
        }
      }
    } finally {
      release.resolve();
      await Promise.allSettled([reservation, request.done]);
    }
  });
});
