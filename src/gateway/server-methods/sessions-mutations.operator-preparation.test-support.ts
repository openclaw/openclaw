import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import * as sessionFork from "../../auto-reply/reply/session-fork.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  registerProjectRegistry,
  selectStoredProjectRegistry,
} from "../../projects/project-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as profileReader from "../../state/user-profile-list.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { createGatewaySession } from "../session-create-service.js";
import * as creationTarget from "../session-create-target.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { startSessionMutationRequest } from "./sessions-mutations.native-consent.test-support.js";
import * as patchDiscovery from "./sessions-patch-discovery.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function registerSessionOperatorPreparationTests(fixture: {
  context: () => GatewayRequestContext;
  profileId: () => string;
  personClient: (profileId: string, scopes: string[]) => GatewayClient;
}) {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-creation-shared-store-");
  const scope = (sessionKey: string) => ({ agentId: "main", sessionKey });
  const entry = (key: string) => loadSessionEntry(scope(key));
  const transcript = (key: string, sessionId: string) =>
    loadTranscriptEvents({ ...scope(key), sessionId });
  const sessionHeader = expect.arrayContaining([expect.objectContaining({ type: "session" })]);
  const incognitoResponse = [
    true,
    {
      key: expect.stringContaining(":incognito-"),
      entry: { incognito: true },
    },
  ];
  const startRequest = (
    method: "sessions.create" | "sessions.patch" | "sessions.patchMany",
    params: Record<string, unknown>,
    caller: GatewayClient,
    context: GatewayRequestContext,
    requestId: string,
    authorize = true,
  ) => {
    const authorization = authorize
      ? resolveSessionMutationAuthorization({
          method,
          client: caller,
          context,
          requestParams: params,
        })
      : undefined;
    if (authorization) {
      expect(authorization.error).toBeNull();
    }
    return startSessionMutationRequest(method, params, {
      req: { type: "req", id: requestId, method, params },
      client: caller,
      context,
      ...(authorization && {
        hasCurrentClientAuthority: () => !caller.invalidated,
        sessionMutationAuthorization: authorization.authorization,
      }),
    });
  };
  const cases = (["sessions.patch", "sessions.patchMany", "sessions.create"] as const).flatMap(
    (method) => (["params", "caller", "target"] as const).map((change) => ({ method, change })),
  );
  function preparedOperator() {
    const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
    const context = fixture.context();
    context.getClientConnIds = (filter) =>
      new Set(
        caller.connId && !caller.invalidated && (!filter || filter(caller)) ? [caller.connId] : [],
      );
    return {
      caller,
      context,
      options: () => ({
        cfg: context.getRuntimeConfig(),
        getCurrentConfig: context.getRuntimeConfig,
        agentId: "main",
        model: "openai/gpt-5.6-sol",
        commandSource: "test",
        requestingOperatorProfileId: fixture.profileId(),
        requestingOperatorScopes: caller.connect.scopes,
        loadGatewayModelCatalogSnapshot: () =>
          context.loadGatewayModelCatalogSnapshot({ agentId: "main" }),
      }),
      start: (
        method: Parameters<typeof startRequest>[0],
        params: Record<string, unknown>,
        requestId: string,
        authorize = true,
      ) => startRequest(method, params, caller, context, requestId, authorize),
    };
  }
  describe("session mutation operator preparation", () => {
    it.for([
      ...cases,
      { method: "sessions.patchMany" as const, change: "duplicate" as const },
      { method: "sessions.create" as const, change: "incognito" as const },
      { method: "sessions.create" as const, change: "explicit-incognito" as const },
      { method: "sessions.create" as const, change: "durable" as const },
    ])(
      "preserves the original $method request when $change changes during authority preparation",
      async ({ method, change }, { signal }) => {
        const key = `agent:main:dashboard:prepare-${method}-${change}`;
        const otherKey = `${key}-other`;
        const originalId = `original-${method}-${change}`;
        for (const [sessionKey, sessionId] of [
          [key, originalId],
          [otherKey, `${originalId}-other`],
        ] as const) {
          await upsertSessionEntryCore(scope(sessionKey), { sessionId, updatedAt: 1 });
        }
        const before = entry(key);
        const otherBefore = entry(otherKey);
        const { caller, start } = preparedOperator();
        const patch = { model: "openai/gpt-5.6-sol", label: `capture-${method}-${change}` };
        const target = { key };
        const params: Record<string, unknown> =
          method === "sessions.patchMany"
            ? { targets: change === "duplicate" ? [target, { key }] : [target], patch }
            : change === "durable"
              ? { agentId: "main", ...patch }
              : change === "incognito"
                ? { agentId: "main", ...patch, incognito: true }
                : change === "explicit-incognito"
                  ? {
                      key: key.replace(":prepare-", ":incognito-prepare-"),
                      ...patch,
                      incognito: true,
                    }
                  : { key, ...patch };
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const releases: ReturnType<typeof vi.fn>[] = [];
        const prepare = profileReader.prepareUserProfileIdentity;
        const spy = vi
          .spyOn(profileReader, "prepareUserProfileIdentity")
          .mockImplementation(async (...args) => {
            const prepared = await prepare(...args);
            const release = vi.fn(prepared.release);
            prepared.release = release;
            releases.push(release);
            entered.resolve();
            await resume.promise;
            return prepared;
          });
        const selectedTarget = createDeferredCore();
        const recordTarget = async <T>(read: Promise<T>) => {
          const selected = await read;
          selectedTarget.resolve();
          return selected;
        };
        const readTarget = creationTarget.readRequestedSessionCreateTarget;
        const discoverTargets = patchDiscovery.discoverSessionPatchTargets;
        const targetReadSpy =
          change !== "target"
            ? undefined
            : method === "sessions.create"
              ? vi
                  .spyOn(creationTarget, "readRequestedSessionCreateTarget")
                  .mockImplementation((...args) => recordTarget(readTarget(...args)))
              : vi
                  .spyOn(patchDiscovery, "discoverSessionPatchTargets")
                  .mockImplementation((...args) => recordTarget(discoverTargets(...args)));
        const request = start(method, params, key);
        const { responses } = request;
        const running = request.running.then(
          () => undefined,
          (error: unknown) => error,
        );
        let replacement: typeof before;
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            request.running,
            "Handler settled before profile preparation",
          );
          if (targetReadSpy) {
            // Profile readiness does not mean the independent worker target read has completed.
            await withinTest(
              awaitGateBeforeSettlement(
                selectedTarget.promise,
                running,
                "Handler settled before selecting the original target",
              ),
              signal,
            );
          }
          if (change === "caller") {
            caller.invalidated = true;
          } else if (change === "target") {
            await upsertSessionEntryCore(scope(key), {
              sessionId: `${originalId}-replacement`,
              updatedAt: 2,
            });
            replacement = entry(key);
          } else if (change === "params") {
            target.key = otherKey;
            patch.model = "anthropic/claude-sonnet-4-6";
            params.key = otherKey;
            params.model = patch.model;
          }
          resume.resolve();
          const error = await running;
          if (change === "durable" || change === "incognito" || change === "explicit-incognito") {
            expect(error).toBeUndefined();
            expect(entry(key)).toEqual(before);
            if (change === "durable") {
              expect(responses[0]?.[0]).toBe(true);
              expect(responses[0]?.[1]).toMatchObject({
                key: expect.stringMatching(/^agent:main:dashboard:(?!incognito-)/),
              });
              expect(responses[0]?.[1]).not.toHaveProperty("entry.incognito", true);
            } else {
              expect(responses[0]).toMatchObject(incognitoResponse);
            }
          } else if (change === "params") {
            expect(error).toBeUndefined();
            expect(responses[0]?.[0]).toBe(true);
            expect(entry(key)).toMatchObject({
              sessionId: originalId,
              providerOverride: "openai",
              modelOverride: "gpt-5.6-sol",
            });
          } else {
            if (error !== undefined) {
              expect(error).toBeInstanceOf(Error);
            } else if (method === "sessions.patchMany" && change !== "duplicate") {
              expect(responses[0]?.[0]).toBe(true);
              expect(responses[0]?.[1]).toMatchObject({ outcomes: [{ ok: false }] });
              expect(responses[0]?.[2]).toBeUndefined();
            } else {
              expect(responses[0]?.[0]).toBe(false);
            }
            expect(entry(key)).toEqual(replacement ?? before);
          }
          expect(entry(otherKey)).toEqual(otherBefore);
          expect(releases.length).toBeGreaterThan(0);
          for (const release of releases) {
            expect(release).toHaveBeenCalledOnce();
          }
        } finally {
          resume.resolve();
          await running;
          spy.mockRestore();
          targetReadSpy?.mockRestore();
        }
      },
    );
    it("creates a logical secondary agent session in the main agent's missing exact shared store", async () => {
      const storePath = path.join(sessionDirs.make(), "shared.sqlite");
      try {
        const { context, start } = preparedOperator();
        const cfg = context.getRuntimeConfig();
        cfg.session = { ...cfg.session, store: storePath };
        await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
        const key = "agent:work:dashboard:shared-physical-main";
        const params = { agentId: "work", key, model: "openai/gpt-5.6-sol" };
        const { responses, running } = start("sessions.create", params, key);
        await running;
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0], JSON.stringify(responses[0])).toBe(true);
        expect(responses[0]?.[1]).toMatchObject({
          key,
          entry: { providerOverride: "openai", modelOverride: "gpt-5.6-sol" },
        });
        const stored = { agentId: "work", sessionKey: key, storePath };
        const created = loadSessionEntry(stored);
        expect(created).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-5.6-sol" });
        expect(loadTranscriptEventsSync({ ...stored, sessionId: created!.sessionId })).toEqual(
          sessionHeader,
        );
        expect(openOpenClawAgentDatabase({ agentId: "main", path: storePath }).agentId).toBe(
          "main",
        );
      } finally {
        await disposeOpenClawAgentDatabaseByPath(storePath);
      }
    });
    it("preserves creation provenance when a stored project reenters its captured existing-schema scope", async () => {
      const root = sessionDirs.make();
      const repoRoot = await initializeRepository(root, "project");
      const project = await registerProjectRegistry({ path: repoRoot });
      const { caller, context, options } = preparedOperator();
      const key = "agent:main:dashboard:captured-project-creation";
      const statePath = resolveOpenClawStateSqlitePath();
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const closeDatabases = async () => {
        try {
          await closeOpenClawAgentDatabaseByPathAsync(agentPath, "main");
        } finally {
          await closeOpenClawStateDatabaseByPathAsync(statePath);
        }
      };
      // Retire normal-scope actors before acquiring the existing-schema policy.
      await closeDatabases();
      await withExistingOpenClawStateSchema({ path: statePath }, async () => {
        const preparation = captureGatewayOperatorRunAuthority({ client: caller, context });
        void preparation.catch(() => {});
        try {
          const result = await createGatewaySession({
            ...options(),
            key,
            operatorAuthority: preparation,
            prepareLifecycle: async () => {
              const selected = await selectStoredProjectRegistry(project.id);
              if (!selected) {
                throw new Error("Prepared project disappeared");
              }
              return {
                ok: true,
                value: {
                  sessionRoot: repoRoot,
                  spawnedCwd: repoRoot,
                  withCommit: (run) =>
                    selected.withCurrent(({ assertCurrent }) => run(assertCurrent)),
                },
              };
            },
          });
          expect(result).toMatchObject({ ok: true, key });
          const created = entry(key);
          expect(created).toMatchObject({ sessionRoot: repoRoot, spawnedCwd: repoRoot });
          expect(
            loadTranscriptEventsSync({ ...scope(key), sessionId: created!.sessionId }),
          ).toEqual(sessionHeader);
        } finally {
          try {
            (await preparation.catch(() => undefined))?.release();
          } finally {
            // Captured worker contexts must drain before their schema scope retires.
            await closeDatabases();
          }
        }
      });
    });
    it("preserves fresh System incognito creation", async () => {
      const { caller, start } = preparedOperator();
      delete caller.authenticatedUserProfile;
      caller.internal = { operatorRoleActor: { kind: "system" } };
      const params = { agentId: "main", incognito: true, model: "openai/gpt-5.6-sol" };
      const { responses, running } = start("sessions.create", params, "system-incognito", false);
      await running;
      expect(responses[0]).toMatchObject(incognitoResponse);
    });
    it.each(
      (["durable", "incognito"] as const).flatMap((storage) => [
        { storage, fork: false, ending: "source-after-commit" as const },
        { storage, fork: true, ending: "source-and-retry" as const },
        { storage, fork: true, ending: "parent-replaced" as const },
      ]),
    )(
      "retains $storage creation custody through transcript preparation and commit (fork=$fork, ending=$ending)",
      async ({ storage, fork, ending }) => {
        const incognito = storage === "incognito";
        const prefix = incognito ? "incognito-" : "";
        const suffix = `${prefix}owned-header-${fork}-${ending}`;
        const parentKey = `agent:main:dashboard:${suffix}-parent`;
        let childKey = `agent:main:dashboard:${suffix}-child`;
        const parentId = `${suffix}-parent-id`;
        const parentScope = { ...scope(parentKey), sessionId: parentId };
        const parentEntry = {
          sessionId: parentId,
          updatedAt: 1,
          ...(incognito ? { incognito: true as const } : {}),
        };
        expect(
          await createSessionEntryWithTranscript(parentScope, () => ({
            ok: true,
            entry: parentEntry,
          })),
        ).toMatchObject({ ok: true });
        await persistSessionTranscriptTurn(parentScope, {
          cwd: "/tmp",
          updateMode: "none",
          messages: (["user", "assistant"] as const).map((role, i) => ({
            message: {
              role,
              content:
                role === "user"
                  ? "Synthetic prompt"
                  : [{ type: "text" as const, text: "Synthetic reply" }],
              timestamp: i + 1,
            },
            now: i + 1,
          })),
        });
        const { caller, context, options } = preparedOperator();
        const prepareFork = sessionFork.prepareSessionForkFromParent;
        const revoked = new Error("original creation source ended before entry commit");
        const runOutsideCreation = AsyncLocalStorage.snapshot();
        let childSessionId: string | undefined;
        let parentReplacement: ReturnType<typeof loadSessionEntry>;
        const assertNoForkState = async (sessionKey: string, sessionId: string) => {
          expect(entry(sessionKey)).toBeUndefined();
          expect(await transcript(sessionKey, sessionId)).toEqual([]);
          if (incognito) {
            return;
          }
          const database = openOpenClawAgentDatabase(
            toDatabaseOptions(resolveSqliteScope(scope(sessionKey))),
          );
          expect(
            database.db
              .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
              .get(sessionKey),
          ).toBeUndefined();
        };
        const createAttempt = async (source: AbortController) => {
          const forked = vi
            .spyOn(sessionFork, "prepareSessionForkFromParent")
            .mockImplementation(async (params) => {
              const prepared = await prepareFork(params);
              if (prepared.status !== "prepared") {
                return prepared;
              }
              await assertNoForkState(params.sessionKey, prepared.transcript.sessionId);
              if (childSessionId) {
                return prepared;
              }
              childSessionId = prepared.transcript.sessionId;
              if (ending === "source-and-retry") {
                source.abort(revoked);
              } else if (ending === "parent-replaced") {
                // The competing parent writer must not borrow the child's actor binding.
                parentReplacement = await runOutsideCreation(async () => {
                  await upsertSessionEntryCore(scope(parentKey), {
                    ...parentEntry,
                    sessionId: `${parentId}-replacement`,
                    updatedAt: 2,
                  });
                  return entry(parentKey);
                });
              }
              return prepared;
            });
          const preparation = captureGatewayOperatorRunAuthority({
            client: caller,
            context,
            invocationAuthority: {
              signal: source.signal,
              assertCurrent: () => source.signal.throwIfAborted(),
            },
          });
          void preparation.catch(() => {});
          try {
            return await createGatewaySession({
              ...options(),
              key: fork && incognito ? undefined : childKey,
              parentSessionKey: fork ? parentKey : undefined,
              fork,
              incognito,
              operatorAuthority: preparation,
              prepareLifecycle: async (target) => {
                childKey = target.key;
                return {
                  ok: true,
                  value: {
                    withCommit: async (run) => {
                      const result = await run(() => source.signal.throwIfAborted());
                      if (!fork && !childSessionId) {
                        const committedEntry = entry(childKey);
                        expect(committedEntry).toHaveProperty("sessionId");
                        childSessionId = committedEntry!.sessionId;
                        expect(await transcript(childKey, childSessionId)).toEqual(sessionHeader);
                        source.abort(revoked);
                      }
                      return result;
                    },
                  },
                };
              },
            });
          } finally {
            forked.mockRestore();
            (await preparation.catch(() => undefined))?.release();
          }
        };
        const outcome = await createAttempt(new AbortController()).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        expect(
          childSessionId,
          "error" in outcome ? String(outcome.error) : JSON.stringify(outcome.result),
        ).toBeDefined();
        if (ending === "parent-replaced") {
          expect(parentReplacement).toMatchObject({ sessionId: `${parentId}-replacement` });
        }
        if (ending === "source-after-commit") {
          expect(outcome).toMatchObject({ result: { ok: true } });
          expect(entry(childKey)).toHaveProperty("sessionId", childSessionId);
        } else {
          if ("error" in outcome) {
            expect(outcome.error).toBeInstanceOf(Error);
            if (ending === "source-and-retry") {
              expect(outcome.error).toHaveProperty(
                "message",
                expect.stringMatching(/creation source ended|operator.*authority.*active/),
              );
            }
          } else {
            expect(outcome.result.ok).toBe(false);
          }
          const rejectedKey = childKey;
          await assertNoForkState(rejectedKey, childSessionId!);
          if (ending === "parent-replaced") {
            expect(entry(parentKey)).toEqual(parentReplacement);
          } else {
            const retry = await createAttempt(new AbortController());
            expect(retry).toMatchObject({ ok: true });
            expect(entry(childKey)).toHaveProperty("sessionId");
            expect(await transcript(rejectedKey, childSessionId!)).toEqual([]);
          }
        }
      },
    );
  });
}
