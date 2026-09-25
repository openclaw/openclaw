import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import * as stateReadWorker from "../state/openclaw-state-read-worker.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  ControlUiSessionPullRequestCheckDetails,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import {
  branch,
  createFixture,
  readerChanges,
  sessionKey,
  snapshot,
  type Load,
} from "./control-ui-session-pr-access.test-support.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createControlUiHandlers } from "./server-methods/control-ui.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

const EVENT = "controlUi.sessionPullRequests.changed";

let sharedState: OpenClawTestState | undefined;
afterAll(async () => {
  await sharedState?.cleanup();
});

async function withFixture(
  scope: OperatorScope,
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  isolated = false,
  initialSessionPatch: Partial<SessionEntry> = {},
) {
  if (isolated) {
    return withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = await createFixture(scope, false, initialSessionPatch);
      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });
  }
  // Only the physical stores survive; every case owns its reader, projection and session rows.
  sharedState ??= await createOpenClawTestState({ scenario: "minimal" });
  sharedState.applyEnv();
  await withStateDatabaseCoordinatorRuntimeDirectory(
    { ...captureStateDatabaseCoordinatorRuntime(), keepAlive: false },
    async () => {
      const work = new AsyncWorkScope();
      let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
      try {
        await work.track(async () => {
          fixture = await createFixture(scope, false, initialSessionPatch);
          try {
            await run(fixture);
          } finally {
            await fixture.close();
          }
        });
      } finally {
        try {
          await work.drain();
        } finally {
          await fixture?.removeSessions();
        }
      }
    },
  );
}

function frames(socket: ReturnType<typeof createGatewayWsTestSocket>) {
  return socket.send.mock.calls.flatMap(([data]) => {
    const frame: unknown = JSON.parse(data);
    return isRecord(frame) && frame.event === EVENT ? [frame] : [];
  });
}

function expectedFrame(key: string, value: ControlUiSessionPullRequests = snapshot) {
  return expect.objectContaining({
    type: "event",
    event: EVENT,
    payload: { sessions: { [key]: { ...value, status: "ready" } } },
  });
}

describe("registered session PR subscriptions", () => {
  it.each(["incarnation", "namespace", "repository"] as const)(
    "retires a captured private PR read after its %s changes",
    async (change) => {
      await withFixture(
        "operator.admin",
        async (f) => {
          const key = "agent:main:dashboard:incognito-pr-retirement";
          const repository = getSessionRepositoryWorkspaceStore().create({
            agentId: "main",
            sessionKey: key,
            url: "https://github.com/synthetic/private",
            branch: "private-change",
            assertCurrent: () => {},
          });
          const entry = { incognito: true as const, repositoryWorkspaceId: repository.workspaceId };
          await f.seed(key, f.profile.id, entry);
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const exposed = vi.fn();
          f.load.mockImplementationOnce(async (_params, _signal, read) => {
            read.assertCurrent();
            entered.resolve();
            await release.promise;
            read.assertCurrent();
            exposed();
            return snapshot;
          });
          const loading = f.subscriptions.replace(f.client.connId!, [key]);
          try {
            await Promise.race([
              entered.promise,
              loading.then(() => {
                throw new Error("Private PR read was not admitted");
              }),
            ]);
            if (change === "repository") {
              await getSessionRepositoryWorkspaceStore().delete({
                workspaceId: repository.workspaceId,
                assertCurrent: () => {},
              });
            } else {
              if (change === "namespace") {
                const source = loadGatewaySessionEntryReadOnly(key, {
                  agentId: "main",
                }).readSource!;
                await closeOpenClawAgentDatabaseByPathAsync(source.path);
              }
              await f.seed(key, f.profile.id, {
                ...entry,
                ...(change === "incarnation" ? { lifecycleRevision: "next" } : {}),
              });
            }
            release.resolve();
            await loading;
            expect(exposed).not.toHaveBeenCalled();
            expect(frames(f.socket)).not.toContainEqual(expectedFrame(key));
          } finally {
            release.resolve();
            await loading;
          }
        },
        true,
      );
    },
  );

  it.each([false, true])(
    "delivers an authorized private session (repository=%s)",
    async (repository) => {
      await withFixture(
        "operator.admin",
        async (f) => {
          const key = "agent:main:dashboard:incognito-pr-reader";
          const workspace = repository
            ? getSessionRepositoryWorkspaceStore().create({
                agentId: "main",
                sessionKey: key,
                url: "https://github.com/synthetic/private",
                branch: "private-change",
                assertCurrent: () => {},
              })
            : undefined;
          await f.seed(key, f.profile.id, {
            incognito: true,
            ...(workspace ? { repositoryWorkspaceId: workspace.workspaceId } : {}),
          });
          await f.subscribe([key]);
          await f.subscriptions.pollNow();
          expect(frames(f.socket)).toContainEqual(expectedFrame(key));
          expect(
            getSessionRowProjection(f.context)
              ?.selectEntries()
              .map((row) => row.key),
          ).not.toContain(key);
        },
        true,
      );
    },
  );

  it.each(["unchanged", "revoked"] as const)(
    "prepares pending topology while preserving %s watcher authority",
    async (authority) => {
      await withFixture("operator.read", async (f) => {
        await f.subscriptions.replace(f.client.connId!, [sessionKey]);
        f.load.mockClear();
        f.socket.send.mockClear();
        const refreshed = { ...snapshot, branch: { ...branch, branch: "after-topology" } };
        f.load.mockResolvedValue(refreshed);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const createTransport = stateReadWorker.createOpenClawStateReadTransport;
        let held = false;
        const transport = vi
          .spyOn(stateReadWorker, "createOpenClawStateReadTransport")
          .mockImplementation((command) => {
            const owned = createTransport(command);
            if (held || command.type !== "agentDatabaseDeletion.snapshot") {
              return owned;
            }
            held = true;
            return {
              ...owned,
              async read(...args: Parameters<typeof owned.read>) {
                const result = await owned.read(...args);
                entered.resolve();
                await release.promise;
                return result;
              },
            };
          });
        sessionChanges.emit({ all: true, scope: "stores" });
        const polling = f.subscriptions.pollNow();
        try {
          await Promise.race([
            entered.promise,
            polling.then(() => {
              throw new Error("PR polling finished before its pending topology was prepared");
            }),
          ]);
          expect(f.load).not.toHaveBeenCalled();
          expect(frames(f.socket)).toEqual([]);
          if (authority === "revoked") {
            await f.changeReader("grant");
          }
          release.resolve();
          await polling;
          await f.subscriptions.pollNow();
          expect(f.load).toHaveBeenCalledTimes(authority === "unchanged" ? 2 : 0);
          expect(frames(f.socket)).toEqual(
            authority === "unchanged" ? [expectedFrame(sessionKey, refreshed)] : [],
          );
        } finally {
          release.resolve();
          await polling;
          transport.mockRestore();
        }
      });
    },
  );

  it.each(["replace", "unsubscribe"] as const)(
    "does not restore a pending watched set after a later %s",
    async (operation) => {
      const first = "agent:main:pending-first";
      const second = "agent:main:current-second";
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let ready = false;
      const load = vi.fn<Load>(async () => snapshot);
      const broadcast = vi.fn();
      const subscriptions = createControlUiSessionPullRequestSubscriptions({
        broadcastToConnIds: broadcast,
        load,
        prepareRead: async (_connId, session) => async () => {
          if (session.sessionKey === first && !ready) {
            entered.resolve();
            await release.promise;
            ready = true;
          }
          return {
            params: { sessionKey: session.sessionKey, agentId: "main" },
            identity: session.sessionKey,
            readSource: { agentId: "main", path: "/synthetic/unused.sqlite" },
            source: null,
          };
        },
      });
      const pending = subscriptions.replace("reader", [first]);
      try {
        await entered.promise;
        if (operation === "replace") {
          await subscriptions.replace("reader", [second]);
        } else {
          subscriptions.unsubscribe("reader");
        }
        release.resolve();
        await pending;
        await subscriptions.pollNow();
        expect(load.mock.calls.map(([params]) => params.sessionKey)).toEqual(
          operation === "replace" ? [second, second] : [],
        );
        expect(broadcast).toHaveBeenCalledTimes(operation === "replace" ? 1 : 0);
      } finally {
        release.resolve();
        await pending;
        await subscriptions.stop();
      }
    },
  );
  it("delivers an archived session that was cold at Gateway startup", async () => {
    await withFixture(
      "operator.read",
      async (f) => {
        const entered = createDeferredCore();
        f.load.mockImplementationOnce(async () => {
          entered.resolve();
          return snapshot;
        });
        await f.subscribe();
        await entered.promise;
        await f.subscriptions.pollNow();
        expect(f.load).toHaveBeenCalledWith(
          { sessionKey, agentId: "main" },
          expect.any(AbortSignal),
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
        expect(frames(f.socket)).toContainEqual(expectedFrame(sessionKey));
      },
      false,
      { archivedAt: 1 },
    );
  });

  it.each(["operator.read", "operator.write", "operator.admin"] as const)(
    "delivers the owned branch through the real broadcaster with %s",
    async (scope) => {
      await withFixture(scope, async (f) => {
        await f.subscribe();
        await f.subscriptions.pollNow();
        expect(f.load).toHaveBeenCalledWith(
          { sessionKey, agentId: "main" },
          expect.any(AbortSignal),
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
        expect(frames(f.socket)).toContainEqual(expectedFrame(sessionKey));
      });
    },
  );

  it("resolves a scoped global watch to its persisted global row", async () => {
    await withFixture("operator.read", async (f) => {
      const watchKey = "agent:main:global";
      await f.seed("global");
      await f.seed(watchKey, f.profile.id, { sessionId: "separate-literal-global-row" });
      await f.subscribe([watchKey]);
      await f.subscriptions.pollNow();
      expect(f.load).toHaveBeenCalledWith(
        { sessionKey: "global", agentId: "main" },
        expect.any(AbortSignal),
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(frames(f.socket)).toEqual([expectedFrame(watchKey)]);
    });
  });

  it.each(["draft", "incognito", "missing"] as const)(
    "does not load or deliver an inaccessible %s target",
    async (kind) => {
      await withFixture("operator.read", async (f) => {
        const key = `agent:main:foreign-${kind}`;
        if (kind !== "missing") {
          await f.seed(
            key,
            f.other.id,
            kind === "draft" ? { visibility: "draft" } : { incognito: true },
          );
        }
        await f.subscribe([key]);
        await f.subscriptions.pollNow();
        expect(f.load).not.toHaveBeenCalled();
        expect(frames(f.socket)).toEqual([]);
      });
    },
  );

  it.each(readerChanges)(
    "rechecks the original reader after a pending snapshot (%s)",
    async (change) => {
      await withFixture("operator.read", async (f) => {
        const key = "agent:main:shared-read";
        await f.seed(key, f.other.id);
        const entered = createDeferredCore();
        const held = createDeferredCore<ControlUiSessionPullRequests>();
        f.load.mockImplementationOnce(async () => {
          entered.resolve();
          return await held.promise;
        });
        try {
          await f.subscribe([key]);
          await entered.promise;
          await f.changeReader(change, key);
          held.resolve(snapshot);
          await f.subscriptions.pollNow();
          expect(frames(f.socket)).toEqual(change === "unchanged" ? [expectedFrame(key)] : []);
        } finally {
          held.resolve(snapshot);
        }
      });
    },
  );

  it.each([
    { retired: "connection", delayed: false },
    { retired: "grant", delayed: false },
    { retired: "connection", delayed: true },
    { retired: "grant", delayed: true },
  ] as const)(
    "keeps a shared load for an unchanged viewer when the other $retired retires (delayed=$delayed)",
    async ({ retired, delayed }) => {
      if (delayed) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      try {
        await withFixture("operator.read", async (f) => {
          const entered = createDeferredCore();
          const held = createDeferredCore<ControlUiSessionPullRequests>();
          const peer = f.addReader("unchanged-reader");
          if (delayed) {
            await f.subscriptions.replace(f.client.connId!, [sessionKey], new Set([sessionKey]));
            await f.subscribe([sessionKey], peer.client);
            // Admission precedes hydration; join the retained cell before measuring refresh delivery.
            await f.subscriptions.replace(peer.client.connId!, [sessionKey]);
            f.load.mockClear();
            f.socket.send.mockClear();
            peer.socket.send.mockClear();
          }
          f.load.mockImplementationOnce(async () => {
            entered.resolve();
            return await held.promise;
          });
          const refreshes: Promise<void>[] = [];
          try {
            if (delayed) {
              for (const client of [f.client, peer.client]) {
                refreshes.push(
                  f.subscriptions.replace(client.connId!, [sessionKey], new Set([sessionKey])),
                );
              }
            } else {
              await f.subscribe();
              await entered.promise;
              await f.subscribe([sessionKey], peer.client);
            }
            if (retired === "connection") {
              f.client.invalidated = true;
            } else {
              f.access.abort(new Error("Original access retired"));
            }
            if (delayed) {
              await vi.advanceTimersByTimeAsync(10_000);
              await entered.promise;
              expect(
                frames(peer.socket),
                "no refresh result before the held loader settles",
              ).toEqual([]);
            }
            held.resolve(snapshot);
            await Promise.all([f.subscriptions.pollNow(), ...refreshes]);
            expect(f.load).toHaveBeenCalledTimes(1);
            expect(frames(f.socket)).toEqual([]);
            expect(frames(peer.socket)).toEqual([expectedFrame(sessionKey)]);
            expect(f.load.mock.calls[0]?.[1]?.aborted).toBe(false);
          } finally {
            held.resolve(snapshot);
          }
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("retires cached branch data after canonical replacement and hydrates the new target", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withFixture("operator.read", async (f) => {
        await f.subscribe();
        await f.subscriptions.replace(f.client.connId!, [sessionKey], new Set([sessionKey]));
        const retiredRefresh = f.subscriptions.replace(
          f.client.connId!,
          [sessionKey],
          new Set([sessionKey]),
        );
        f.socket.send.mockClear();
        const original = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" });
        await expect(
          deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: original.storePath,
            target: { canonicalKey: original.canonicalKey, storeKeys: original.storeKeys },
            expectedSessionId: f.sessionId,
            archiveTranscript: false,
          }),
        ).resolves.toMatchObject({ deleted: true });
        await f.seed(sessionKey, f.profile.id, {
          sessionId: "replacement-publication",
          updatedAt: 2,
        });
        const replacement = { ...snapshot, branch: { ...branch, branch: "replacement-change" } };
        f.load.mockResolvedValue(replacement);
        await Promise.all([f.subscriptions.pollNow(), retiredRefresh]);
        expect(f.load).toHaveBeenCalledTimes(3);
        expect(frames(f.socket)).toEqual([expectedFrame(sessionKey, replacement)]);
        const peer = f.addReader("replacement-reader");
        await f.subscribe([sessionKey], peer.client);
        await f.subscriptions.pollNow();
        expect(frames(peer.socket)).toEqual([expectedFrame(sessionKey, replacement)]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("registered session PR check details", () => {
  it("reads archived check details after archive cache invalidation", async () => {
    await withFixture(
      "operator.read",
      async (f) => {
        const projection = getSessionRowProjection(f.context);
        if (!projection) {
          throw new Error("Missing session projection for archived PR checks");
        }
        expect(projection.snapshot({ agentId: "main", key: sessionKey }).row).toBeDefined();
        sessionChanges.emit({ all: true, scope: "catalog" });
        await projection.ensureMaterialized();
        expect(
          projection.capture({ agentId: "main", key: sessionKey })?.materialized,
        ).toBeUndefined();

        const result: ControlUiSessionPullRequestCheckDetails = {
          owner: "synthetic",
          repo: "publication",
          number: 1,
          headSha: "a".repeat(40),
          status: "ready",
          rateLimited: false,
          checks: [],
        };
        const load = vi.fn(async () => result);
        const respond = vi.fn();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "archived-checks",
            method: "controlUi.sessionPullRequests.checks",
            params: {
              sessionKey,
              owner: result.owner,
              repo: result.repo,
              number: result.number,
              headSha: result.headSha,
            },
          },
          client: f.client,
          context: f.context,
          extraHandlers: createControlUiHandlers(undefined, undefined, load),
          isWebchatConnect: () => false,
          respond,
        });
        expect(load).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
      },
      false,
      { archivedAt: 1 },
    );
  });

  it.each([
    ...readerChanges,
    "selection",
    "literal-global",
    "literal-global-visibility",
    "store closure",
  ] as const)("keeps pending details bound to the original reader (%s)", async (change) => {
    await withFixture(
      "operator.read",
      async (f) => {
        const key = change.startsWith("literal-global")
          ? "agent:main:global"
          : "agent:main:shared-checks";
        if (change === "literal-global-visibility") {
          await f.seed("global", f.profile.id, { sessionId: "separate-global-row" });
        }
        const replacementKey = `${key}:replacement`;
        const projection = getSessionRowProjection(f.context);
        if (change === "selection") {
          await f.seed(replacementKey, f.other.id);
          await projection?.ensureMaterialized();
        }
        const mutation =
          change === "literal-global"
            ? "unchanged"
            : change === "literal-global-visibility"
              ? "visibility"
              : change;
        await f.seed(key, f.other.id);
        const params = {
          sessionKey: key,
          owner: "synthetic",
          repo: "publication",
          number: 1,
          headSha: "a".repeat(40),
        };
        const result: ControlUiSessionPullRequestCheckDetails = {
          owner: params.owner,
          repo: params.repo,
          number: params.number,
          headSha: params.headSha,
          status: "ready",
          rateLimited: false,
          checks: [],
        };
        const entered = createDeferredCore();
        const held = createDeferredCore<ControlUiSessionPullRequestCheckDetails>();
        const load = vi.fn(async () => {
          entered.resolve();
          return await held.promise;
        });
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "pending-checks",
            method: "controlUi.sessionPullRequests.checks",
            params,
          },
          client: f.client,
          context: f.context,
          extraHandlers: createControlUiHandlers(undefined, undefined, load),
          isWebchatConnect: () => false,
          respond,
        });
        try {
          await Promise.race([
            entered.promise,
            request.then(() => {
              throw new Error("The registered check-details loader was not entered");
            }),
          ]);
          if (mutation === "store closure") {
            const source = loadGatewaySessionEntryReadOnly(key, { agentId: "main" }).readSource;
            expect(source).toBeDefined();
            await closeOpenClawAgentDatabaseByPathAsync(source!.path);
          } else if (mutation === "selection") {
            if (!projection) {
              throw new Error("Missing session projection for selection replacement");
            }
            const capture = projection.capture.bind(projection);
            const replacement = capture({ agentId: "main", key: replacementKey });
            expect(replacement).toBeDefined();
            vi.spyOn(projection, "capture").mockImplementation((query) =>
              query.key === key ? replacement : capture(query),
            );
          } else {
            await f.changeReader(mutation, key);
          }
          held.resolve(result);
          await request;
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            mutation === "unchanged",
            mutation === "unchanged" ? result : undefined,
            mutation === "unchanged"
              ? undefined
              : expect.objectContaining({
                  code: "UNAVAILABLE",
                  ...(mutation === "store closure"
                    ? {}
                    : { message: "Session changed; reopen CI details" }),
                }),
          );
        } finally {
          held.resolve(result);
          await request;
        }
      },
      change === "store closure",
    );
  });
});

it.each(["local", "repository"] as const)(
  "reuses prepared %s rows for warm readers without SQLite freshness polling",
  async (source) => {
    await withFixture("operator.read", async (f) => {
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository =
        source === "repository"
          ? repositories.create({
              agentId: "main",
              sessionKey,
              url: "https://github.com/synthetic/publication",
              branch: "guest-change",
              assertCurrent: () => {},
            })
          : undefined;
      if (repository) {
        await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      }
      await f.subscribe();
      for (let index = 1; index < 20; index++) {
        await f.subscribe([sessionKey], f.addReader(`warm-reader-${index}`).client);
      }
      await f.subscriptions.pollNow();
      const statements = observeSqliteReadSql(StatementSync.prototype);
      f.load.mockClear();
      try {
        for (let index = 0; index < 3; index++) {
          await f.subscriptions.pollNow();
        }
        const queries = statements.queries.map((sql) => sql.toLowerCase());
        expect({
          sessionReads: queries.filter((sql) => sql.includes("session_nodes")).length,
          repositoryReads: queries.filter((sql) => sql.includes("session_repository_workspaces"))
            .length,
          freshnessReads: queries.filter(
            (sql) => sql.includes("pragma") || sql.includes("cache_generation"),
          ).length,
        }).toEqual({ sessionReads: 0, repositoryReads: 0, freshnessReads: 0 });
        expect(f.load).toHaveBeenCalledTimes(3);
        expect(frames(f.socket)).toEqual([expectedFrame(sessionKey)]);
      } finally {
        statements.restore();
      }
      if (repository) {
        const previousCache = f.load.mock.calls[0]?.[1];
        await repositories.delete({ workspaceId: repository.workspaceId, assertCurrent: () => {} });
        const unavailable = { pullRequests: [], rateLimited: false };
        f.load.mockResolvedValue(unavailable);
        await f.subscriptions.pollNow();
        expect(previousCache?.aborted).toBe(true);
        expect(frames(f.socket)).toEqual([
          expectedFrame(sessionKey),
          expectedFrame(sessionKey, unavailable),
        ]);
      }
    });
  },
);

it("keeps warm default-loader SQL constant as readers join without a native row transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const provider = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith("/pulls")) {
        return githubJson([
          pullListItem({
            state: "closed",
            head: {},
            base: { ref: "main", repo: { name: "publication", owner: { login: "synthetic" } } },
          }),
        ]);
      }
      throw new Error(`Unexpected warm PR request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      const repository = getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: "https://github.com/synthetic/publication",
        branch: "guest-change",
        assertCurrent: () => {},
      });
      await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      await f.subscribe();
      await f.subscriptions.pollNow();
      const measure = async () => {
        const statements = observeSqliteReadSql(StatementSync.prototype);
        const executions = vi.spyOn(DatabaseSync.prototype, "exec");
        try {
          for (let index = 0; index < 3; index++) {
            await f.subscriptions.pollNow();
          }
          const queries = statements.queries.map((sql) => sql.toLowerCase());
          return {
            sessionReads: queries.filter((sql) => sql.includes("session_nodes")).length,
            repositoryReads: queries.filter((sql) => sql.includes("session_repository_workspaces"))
              .length,
            transactions: executions.mock.calls.filter(([sql]) => /^\s*begin\b/iu.test(sql)).length,
          };
        } finally {
          executions.mockRestore();
          statements.restore();
        }
      };
      const oneReader = await measure();
      for (let index = 1; index < 20; index++) {
        await f.subscribe([sessionKey], f.addReader(`default-reader-${index}`).client);
      }
      const twentyReaders = await measure();
      console.info("PR_DEFAULT_LOADER_SQL", JSON.stringify({ oneReader, twentyReaders }));
      expect(twentyReaders).toEqual(oneReader);
      expect(oneReader.transactions).toBe(0);
      expect(frames(f.socket)).toHaveLength(1);
      expect(JSON.stringify(frames(f.socket))).toContain('"number":103469');
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

it("drops cached subscription hydration after physical database replacement", async () => {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      let rateLimited = false;
      const provider = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(requestUrl(input));
        if (!url.pathname.endsWith("/pulls")) {
          throw new Error(`Unexpected replacement PR request: ${url.pathname}`);
        }
        return rateLimited
          ? githubJson({ message: "Rate limited" }, 429)
          : githubJson([
              pullListItem({
                number: 300,
                html_url: "https://github.com/synthetic/publication/pull/300",
                state: "closed",
                head: {},
                base: { ref: "main", repo: { name: "publication", owner: { login: "synthetic" } } },
              }),
            ]);
      });
      vi.stubGlobal("fetch", provider);
      const f = await createFixture("operator.read", true);
      try {
        const repository = getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey,
          url: "https://github.com/synthetic/publication",
          branch: "guest-change",
          assertCurrent: () => {},
        });
        await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
        await f.subscribe();
        await f.subscriptions.pollNow();
        expect(frames(f.socket)).toMatchObject([
          { payload: { sessions: { [sessionKey]: { pullRequests: [{ number: 300 }] } } } },
        ]);
        const requestsBeforeReplacement = provider.mock.calls.length;
        const source = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" }).readSource;
        if (!source) {
          throw new Error("Missing session PR source after initial delivery");
        }
        // Checkpoint the native owner, then replace only the file identity; logical headers match.
        await closeOpenClawAgentDatabaseByPathAsync(source.path);
        const replacementPath = `${source.path}.replacement`;
        copyFileSync(source.path, replacementPath);
        renameSync(replacementPath, source.path);
        rateLimited = true;

        const peer = f.addReader("physical-replacement-reader");
        await f.subscribe([sessionKey], peer.client);
        // Join native work without forcing a refresh or discarding the existing subscription cache.
        await f.subscriptions.pollNow();
        expect(frames(peer.socket)).toMatchObject([
          {
            payload: {
              sessions: {
                [sessionKey]: { pullRequests: [], rateLimited: true, status: "rate-limited" },
              },
            },
          },
        ]);
        expect(provider).toHaveBeenCalledTimes(requestsBeforeReplacement + 1);
      } finally {
        await f.close();
      }
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it.each(["concurrency limit", "earlier refresh", "refresh timer", "publication"] as const)(
  "retires default PR loads queued behind %s",
  async (waitingOn) => {
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        vi.stubEnv("GH_TOKEN", "");
        vi.stubEnv("GITHUB_TOKEN", "");
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const lookedUp: string[] = [];
        const activeLoads = waitingOn === "concurrency limit" ? 4 : 1;
        if (waitingOn === "refresh timer") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          release.resolve();
        }
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input) => {
            const url = new URL(
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            );
            if (url.pathname.endsWith("/pulls")) {
              lookedUp.push(url.pathname);
              if (lookedUp.length === activeLoads) {
                entered.resolve();
              }
              await release.promise;
              return githubJson([pullListItem({ state: "closed", head: {} })]);
            }
            return githubJson({ additions: 1, deletions: 0 });
          }),
        );
        const f = await createFixture("operator.read", true);
        try {
          const keys = [];
          for (let index = 0; index < (waitingOn === "concurrency limit" ? 5 : 1); index++) {
            const key = `agent:main:queued-pr-${index}`;
            keys.push(key);
            const repository = getSessionRepositoryWorkspaceStore().create({
              agentId: "main",
              sessionKey: key,
              url: `https://github.com/synthetic/queued-${index}`,
              branch: "guest-change",
              assertCurrent: () => {},
            });
            await f.seed(key, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
          }
          if (waitingOn === "refresh timer") {
            await f.subscriptions.replace(f.client.connId!, keys, new Set(keys));
            f.socket.send.mockClear();
          } else {
            await f.subscribe(keys);
            await entered.promise;
          }
          const queuedRefresh =
            waitingOn === "earlier refresh" || waitingOn === "refresh timer"
              ? f.subscriptions.replace(f.client.connId!, keys, new Set(keys))
              : Promise.resolve();
          const source = loadGatewaySessionEntryReadOnly(keys[0]!, { agentId: "main" }).readSource;
          expect(source).toBeDefined();
          let retirement: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
          const peer = waitingOn === "publication" ? f.addReader("publication-peer") : undefined;
          if (peer) {
            await f.subscribe(keys, peer.client);
            f.socket.send.mockImplementationOnce(() => {
              retirement = closeOpenClawAgentDatabaseByPathAsync(source!.path);
            });
          } else {
            await closeOpenClawAgentDatabaseByPathAsync(source!.path);
          }
          release.resolve();
          const settled = Promise.all([f.subscriptions.pollNow(), queuedRefresh]);
          if (waitingOn === "refresh timer") {
            await vi.advanceTimersByTimeAsync(10_000);
          }
          await settled;
          await retirement;
          expect(lookedUp).toHaveLength(activeLoads);
          expect(lookedUp.some((url) => url.includes("queued-4"))).toBe(false);
          if (peer) {
            expect(JSON.stringify(frames(f.socket))).toContain('"number":103469');
            expect(JSON.stringify(frames(peer.socket))).not.toContain('"number":103469');
          } else {
            expect(JSON.stringify(frames(f.socket))).not.toContain('"number":103469');
          }
        } finally {
          release.resolve();
          await f.close();
        }
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
