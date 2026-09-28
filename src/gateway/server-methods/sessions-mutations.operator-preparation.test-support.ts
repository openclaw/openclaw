import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sessionFork from "../../auto-reply/reply/session-fork.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import * as transcriptHeader from "../../config/sessions/session-accessor.sqlite-transcript-header.js";
import {
  registerProjectRegistry,
  selectStoredProjectRegistry,
} from "../../projects/project-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as profileReader from "../../state/user-profile-list.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { initializeRepository } from "../server.sessions.create.projects.test-support.js";
import { createGatewaySession } from "../session-create-service.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function registerSessionOperatorPreparationTests(fixture: {
  context: () => GatewayRequestContext;
  profileId: () => string;
  personClient: (profileId: string, scopes: string[]) => GatewayClient;
}) {
  const contextFor = (client: GatewayClient) => {
    const context = fixture.context();
    context.getClientConnIds = (filter) =>
      new Set(
        client.connId && !client.invalidated && (!filter || filter(client)) ? [client.connId] : [],
      );
    return context;
  };
  const cases = (["sessions.patch", "sessions.patchMany", "sessions.create"] as const).flatMap(
    (method) => (["params", "caller", "target"] as const).map((change) => ({ method, change })),
  );
  describe("session mutation operator preparation", () => {
    it.each([
      ...cases,
      { method: "sessions.patchMany" as const, change: "duplicate" as const },
      { method: "sessions.create" as const, change: "incognito" as const },
      { method: "sessions.create" as const, change: "explicit-incognito" as const },
      { method: "sessions.create" as const, change: "durable" as const },
    ])(
      "preserves the original $method request when $change changes during authority preparation",
      async ({ method, change }) => {
        const key = `agent:main:dashboard:prepare-${method}-${change}`;
        const otherKey = `${key}-other`;
        const originalId = `original-${method}-${change}`;
        for (const [sessionKey, sessionId] of [
          [key, originalId],
          [otherKey, `${originalId}-other`],
        ] as const) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            { sessionId, updatedAt: 1 },
          );
        }
        const before = loadSessionEntry({ agentId: "main", sessionKey: key });
        const otherBefore = loadSessionEntry({ agentId: "main", sessionKey: otherKey });
        const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
        const context = contextFor(caller);
        const patch = { model: "openai/gpt-5.6-sol", label: `capture-${method}-${change}` };
        const target = { key };
        const params: Record<string, unknown> =
          method === "sessions.patchMany"
            ? { targets: change === "duplicate" ? [target, { key }] : [target], patch }
            : change === "durable"
              ? { ...patch }
              : change === "incognito"
                ? { ...patch, incognito: true }
                : change === "explicit-incognito"
                  ? {
                      key: key.replace(":prepare-", ":incognito-prepare-"),
                      ...patch,
                      incognito: true,
                    }
                  : { key, ...patch };
        const authorized = resolveSessionMutationAuthorization({
          method,
          client: caller,
          context,
          requestParams: params,
        });
        expect(authorized.error).toBeNull();
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
        const responses: Parameters<RespondFn>[] = [];
        const handler =
          method === "sessions.create"
            ? sessionCreateHandlers[method]!
            : sessionMutationHandlers[method]!;
        const running = Promise.resolve(
          handler({
            req: { type: "req", id: key, method, params },
            params,
            context,
            client: caller,
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: () => !caller.invalidated,
            sessionMutationAuthorization: authorized.authorization,
            respond: (...response) => {
              responses.push(response);
            },
          }),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        let replacement: typeof before;
        try {
          await Promise.race([
            entered.promise,
            running.then((error) => {
              if (error !== undefined) {
                if (error instanceof Error) {
                  throw error;
                }
                throw new Error("Handler failed before profile preparation", { cause: error });
              }
              throw new Error(
                `Handler settled before profile preparation: ${JSON.stringify(responses)}`,
              );
            }),
          ]);
          if (change === "caller") {
            caller.invalidated = true;
          } else if (change === "target") {
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: key },
              { sessionId: `${originalId}-replacement`, updatedAt: 2 },
            );
            replacement = loadSessionEntry({ agentId: "main", sessionKey: key });
          } else if (change === "params") {
            target.key = otherKey;
            patch.model = "anthropic/claude-sonnet-4-6";
            params.key = otherKey;
            params.model = patch.model;
          }
          resume.resolve();
          const error = await running;
          if (change === "durable") {
            expect(error).toBeUndefined();
            expect(responses[0]?.[0]).toBe(true);
            expect(responses[0]?.[1]).toMatchObject({
              key: expect.stringMatching(/^agent:main:dashboard:(?!incognito-)/),
            });
            expect(responses[0]?.[1]).not.toHaveProperty("entry.incognito", true);
            expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(before);
          } else if (change === "incognito" || change === "explicit-incognito") {
            expect(error).toBeUndefined();
            expect(responses[0]).toMatchObject([
              true,
              {
                key: expect.stringContaining(":incognito-"),
                entry: { incognito: true },
              },
            ]);
            expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(before);
          } else if (change === "params") {
            expect(error).toBeUndefined();
            expect(responses[0]?.[0]).toBe(true);
            expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
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
            expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toEqual(
              replacement ?? before,
            );
          }
          expect(loadSessionEntry({ agentId: "main", sessionKey: otherKey })).toEqual(otherBefore);
          expect(releases.length).toBeGreaterThan(0);
          for (const release of releases) {
            expect(release).toHaveBeenCalledOnce();
          }
        } finally {
          resume.resolve();
          await running;
          spy.mockRestore();
        }
      },
    );
    it.each(["existing", "missing"] as const)(
      "creates a logical secondary agent session in the main agent's %s exact shared store",
      async (birth) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-creation-shared-store-"));
        const storePath = path.join(root, "shared.sqlite");
        try {
          const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
          const context = contextFor(caller);
          const cfg = context.getRuntimeConfig();
          cfg.session = { ...cfg.session, store: storePath };
          const physicalDatabase =
            birth === "existing"
              ? openOpenClawAgentDatabase({ agentId: "main", path: storePath })
              : undefined;
          if (physicalDatabase) {
            expect(physicalDatabase.agentId).toBe("main");
          } else {
            await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
          }
          const key = "agent:work:dashboard:shared-physical-main";
          const params = { agentId: "work", key, model: "openai/gpt-5.6-sol" };
          const authorized = resolveSessionMutationAuthorization({
            method: "sessions.create",
            client: caller,
            context,
            requestParams: params,
          });
          expect(authorized.error).toBeNull();
          const responses: Parameters<RespondFn>[] = [];
          await sessionCreateHandlers["sessions.create"]!({
            req: { type: "req", id: key, method: "sessions.create", params },
            params,
            client: caller,
            context,
            isWebchatConnect: () => true,
            hasCurrentClientAuthority: () => !caller.invalidated,
            sessionMutationAuthorization: authorized.authorization,
            respond: (...response) => {
              responses.push(response);
            },
          });
          expect(responses).toHaveLength(1);
          expect(responses[0]?.[0], JSON.stringify(responses[0])).toBe(true);
          expect(responses[0]?.[1]).toMatchObject({
            key,
            entry: { providerOverride: "openai", modelOverride: "gpt-5.6-sol" },
          });
          const entry = loadSessionEntry({ agentId: "work", sessionKey: key, storePath });
          expect(entry).toMatchObject({ providerOverride: "openai", modelOverride: "gpt-5.6-sol" });
          expect(
            loadTranscriptEventsSync({
              agentId: "work",
              sessionKey: key,
              sessionId: entry!.sessionId,
              storePath,
            }),
          ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session" })]));
          const currentDatabase = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
          expect(currentDatabase.agentId).toBe("main");
          if (physicalDatabase) {
            expect(currentDatabase).toBe(physicalDatabase);
          }
        } finally {
          disposeOpenClawAgentDatabaseByPath(storePath);
          await fs.rm(root, { recursive: true, force: true });
        }
      },
    );
    it("preserves creation provenance when a stored project reenters its captured existing-schema scope", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-creation-schema-project-"));
      try {
        const repoRoot = await initializeRepository(root, "project");
        const project = await registerProjectRegistry({ path: repoRoot });
        const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
        const context = contextFor(caller);
        const key = "agent:main:dashboard:captured-project-creation";
        const stateDatabasePath = resolveOpenClawStateSqlitePath();
        const agentDatabasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        // Retire normal-scope actors before acquiring the existing-schema policy.
        await closeOpenClawAgentDatabaseByPathAsync(agentDatabasePath, "main");
        await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
        await withExistingOpenClawStateSchema({ path: stateDatabasePath }, async () => {
          const preparation = captureGatewayOperatorRunAuthority({ client: caller, context });
          void preparation.catch(() => {});
          try {
            const result = await createGatewaySession({
              cfg: context.getRuntimeConfig(),
              getCurrentConfig: context.getRuntimeConfig,
              agentId: "main",
              key,
              model: "openai/gpt-5.6-sol",
              commandSource: "test",
              requestingOperatorProfileId: fixture.profileId(),
              requestingOperatorScopes: caller.connect.scopes,
              operatorAuthority: preparation,
              loadGatewayModelCatalogSnapshot: () =>
                context.loadGatewayModelCatalogSnapshot({ agentId: "main" }),
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
            const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
            expect(entry).toMatchObject({ sessionRoot: repoRoot, spawnedCwd: repoRoot });
            expect(
              loadTranscriptEventsSync({
                agentId: "main",
                sessionKey: key,
                sessionId: entry!.sessionId,
              }),
            ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session" })]));
          } finally {
            try {
              (await preparation.catch(() => undefined))?.release();
            } finally {
              // Captured worker contexts must drain before their schema scope retires.
              try {
                await closeOpenClawAgentDatabaseByPathAsync(agentDatabasePath, "main");
              } finally {
                await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
              }
            }
          }
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    it("preserves fresh System incognito creation", async () => {
      const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
      delete caller.authenticatedUserProfile;
      caller.internal = { operatorRoleActor: { kind: "system" } };
      const params = { incognito: true, model: "openai/gpt-5.6-sol" };
      const responses: Parameters<RespondFn>[] = [];
      await sessionCreateHandlers["sessions.create"]!({
        req: { type: "req", id: "system-incognito", method: "sessions.create", params },
        params,
        client: caller,
        context: contextFor(caller),
        isWebchatConnect: () => true,
        respond: (...response) => {
          responses.push(response);
        },
      });
      expect(responses[0]).toMatchObject([
        true,
        {
          key: expect.stringContaining(":incognito-"),
          entry: { incognito: true },
        },
      ]);
    });
    it.each(
      (["durable", "incognito"] as const).flatMap((storage) => [
        { storage, fork: false, ending: "complete" as const },
        { storage, fork: true, ending: "complete" as const },
        {
          storage,
          fork: false,
          ending:
            storage === "durable"
              ? ("source-after-commit" as const)
              : ("source-and-retry" as const),
        },
        { storage, fork: true, ending: "source-and-retry" as const },
        { storage, fork: true, ending: "parent-replaced" as const },
      ]),
    )(
      "retains $storage creation custody through transcript preparation and commit (fork=$fork, ending=$ending)",
      async ({ storage, fork, ending }) => {
        const prefix = storage === "incognito" ? "incognito-" : "";
        const suffix = `${prefix}owned-header-${fork}-${ending}`;
        const parentKey = `agent:main:dashboard:${suffix}-parent`;
        let childKey = `agent:main:dashboard:${suffix}-child`;
        const parentId = `${suffix}-parent-id`;
        const parentScope = { agentId: "main", sessionKey: parentKey, sessionId: parentId };
        const parentEntry = {
          sessionId: parentId,
          updatedAt: 1,
          ...(storage === "incognito" ? { incognito: true as const } : {}),
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
          messages: [
            {
              message: {
                role: "user",
                content: "Synthetic parent content for owned fork proof.",
                timestamp: 1,
              },
              now: 1,
            },
            {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic completed parent reply." }],
                timestamp: 2,
              },
              now: 2,
            },
          ],
        });
        const caller = fixture.personClient(fixture.profileId(), ["operator.admin"]);
        const context = contextFor(caller);
        const getCurrentConfig = context.getRuntimeConfig;
        const header = vi.spyOn(transcriptHeader, "ensureTranscriptHeader");
        const prepareFork = sessionFork.prepareSessionForkFromParent;
        const revoked = new Error("original creation source ended before entry commit");
        let childSessionId: string | undefined;
        let parentReplacement: ReturnType<typeof loadSessionEntry>;
        const assertNoForkState = (sessionKey: string, sessionId: string) => {
          expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
          expect(loadTranscriptEventsSync({ agentId: "main", sessionKey, sessionId })).toEqual([]);
          const database = openOpenClawAgentDatabase(
            toDatabaseOptions(resolveSqliteScope({ agentId: "main", sessionKey })),
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
              if (prepared.status === "prepared") {
                assertNoForkState(params.sessionKey, prepared.transcript.sessionId);
                if (!childSessionId) {
                  childSessionId = prepared.transcript.sessionId;
                  if (ending === "source-and-retry") {
                    source.abort(revoked);
                  } else if (ending === "parent-replaced") {
                    await upsertSessionEntryCore(
                      { agentId: "main", sessionKey: parentKey },
                      {
                        ...parentEntry,
                        sessionId: `${parentId}-replacement`,
                        updatedAt: 2,
                      },
                    );
                    parentReplacement = loadSessionEntry({
                      agentId: "main",
                      sessionKey: parentKey,
                    });
                  }
                }
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
              cfg: getCurrentConfig(),
              getCurrentConfig,
              agentId: "main",
              key: fork && storage === "incognito" ? undefined : childKey,
              parentSessionKey: fork ? parentKey : undefined,
              fork,
              incognito: storage === "incognito",
              model: "openai/gpt-5.6-sol",
              commandSource: "test",
              requestingOperatorProfileId: fixture.profileId(),
              requestingOperatorScopes: caller.connect.scopes,
              operatorAuthority: preparation,
              loadGatewayModelCatalogSnapshot: () =>
                context.loadGatewayModelCatalogSnapshot({ agentId: "main" }),
              prepareLifecycle: async (target) => {
                childKey = target.key;
                return {
                  ok: true,
                  value: {
                    withCommit: async (run) => {
                      const result = await run(() => source.signal.throwIfAborted());
                      if (!fork && !childSessionId) {
                        const committedEntry = loadSessionEntry({
                          agentId: "main",
                          sessionKey: childKey,
                        });
                        let childId = committedEntry?.sessionId;
                        childId ??= header.mock.calls.find(
                          ([, scope]) => scope.sessionKey === childKey,
                        )?.[1].sessionId;
                        if (childId) {
                          const transcript = loadTranscriptEventsSync({
                            agentId: "main",
                            sessionKey: childKey,
                            sessionId: childId,
                          });
                          expect(transcript).toEqual(
                            expect.arrayContaining([expect.objectContaining({ type: "session" })]),
                          );
                          if (storage === "durable") {
                            expect(committedEntry).toMatchObject({ sessionId: childId });
                          } else {
                            expect(committedEntry).toBeUndefined();
                          }
                          childSessionId = childId;
                          if (ending === "source-and-retry" || ending === "source-after-commit") {
                            source.abort(revoked);
                          }
                        }
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
        try {
          const outcome = await createAttempt(new AbortController()).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          expect(childSessionId).toBeDefined();
          if (ending === "complete" || ending === "source-after-commit") {
            expect(outcome).toMatchObject({ result: { ok: true } });
            expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toHaveProperty(
              "sessionId",
              childSessionId,
            );
            if (fork) {
              expect(
                loadTranscriptEventsSync({
                  agentId: "main",
                  sessionKey: childKey,
                  sessionId: childSessionId!,
                }),
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    type: "message",
                    message: expect.objectContaining({
                      role: "assistant",
                      content: [{ type: "text", text: "Synthetic completed parent reply." }],
                    }),
                  }),
                ]),
              );
            }
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
            expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toBeUndefined();
            const rejectedKey = childKey;
            if (fork) {
              assertNoForkState(rejectedKey, childSessionId!);
            } else {
              expect(
                loadTranscriptEventsSync({
                  agentId: "main",
                  sessionKey: rejectedKey,
                  sessionId: childSessionId!,
                }),
              ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session" })]));
            }
            if (ending === "parent-replaced") {
              expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(
                parentReplacement,
              );
            } else {
              const retry = await createAttempt(new AbortController());
              expect(retry).toMatchObject({ ok: true });
              expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toHaveProperty(
                "sessionId",
              );
              expect(
                loadTranscriptEventsSync({
                  agentId: "main",
                  sessionKey: rejectedKey,
                  sessionId: childSessionId!,
                }),
              ).toEqual(
                fork ? [] : expect.arrayContaining([expect.objectContaining({ type: "session" })]),
              );
            }
          }
        } finally {
          header.mockRestore();
        }
      },
    );
  });
}
