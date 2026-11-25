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
import { readSessionMembersInWorker } from "../../config/sessions/session-sharing-store.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
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

type MetadataMethod = "session.members.add" | "session.suggestions.add" | "sessions.assignOwner";
const handlers: GatewayRequestHandlers = {
  ...sessionMutationHandlers,
  ...sessionSharingHandlers,
  ...sessionSuggestionHandlers,
};

afterEach(() => flushPendingSessionsChangedEvents());

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

async function reserve(
  options: Parameters<typeof runOpenClawAgentWorkerWrite>[0],
  beforeRelease: () => void,
) {
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

function paramsFor(method: MetadataMethod, key: string, identityId: string) {
  if (method === "sessions.assignOwner") {
    return { key, owner: { type: "human", id: identityId } };
  }
  if (method === "session.suggestions.add") {
    return { sessionKey: key, text: "synthetic suggestion" };
  }
  return { sessionKey: key, identityId };
}

it.each([
  ["retired", "sessions.assignOwner"],
  ["retired", "session.members.add"],
  ["retired", "session.suggestions.add"],
  ["owner", "sessions.assignOwner"],
  ["visibility", "session.suggestions.add"],
  ["config", "session.suggestions.add"],
] as const)("%s: %s respects writer admission", async (kind, method) => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
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
      const options = { ...scope, path: database.path };
      const replacement = { ...scope, storePath: state.path("replacement-store.sqlite") };
      const retired = { ...scope, storePath: state.path("retired-store.sqlite") };
      const originalEntry = loadSessionEntry(scope)!;
      if (kind === "retired") {
        // This copy joins discovery only after the config switch.
        await backup(requireNativeSqliteDatabase(database.db), replacement.storePath);
      }
      let cfg: OpenClawConfig =
        kind === "owner"
          ? { agents: { entries: { main: {}, research: {} } } }
          : kind === "retired"
            ? { session: { store: options.path } }
            : {};
      const context = sessionSharingTestContext(vi.fn());
      context.getRuntimeConfig = () => cfg;
      setRuntimeConfigSnapshot(cfg);
      await initializeSessionReadContext(context);
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
        if (kind === "retired") {
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
      } finally {
        release.resolve();
        await Promise.allSettled([reservation, request.done]);
      }
    },
  );
});
