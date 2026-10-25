import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { runExec } from "../process/exec.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import * as stateReadWorker from "../state/openclaw-state-read-worker.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
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
import * as checkDetails from "./control-ui-session-pr-check-details.js";
import {
  createControlUiSessionPrRead,
  prepareControlUiSessionPrServiceTarget,
} from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import {
  createTestSessionPrReadSource,
  spyOnSessionPrLoader,
} from "./control-ui-session-pr-subscriptions.test-support.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import { controlUiHandlers } from "./server-methods/control-ui.js";
import { createGatewayWsTestSocket } from "./server/ws-connection.test-helpers.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

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
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
  const runFixture = async () => {
    fixture = await createFixture(scope, false, initialSessionPatch);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  };
  if (isolated) {
    return withOpenClawTestState({ scenario: "minimal" }, runFixture);
  }
  // Only physical stores survive; cases own their reader, projection and session rows.
  sharedState ??= await createOpenClawTestState({ scenario: "minimal" });
  sharedState.applyEnv();
  const work = new AsyncWorkScope();
  try {
    await work.track(runFixture);
  } finally {
    try {
      await work.drain();
    } finally {
      await fixture?.removeSessions();
    }
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function holdLoad<T>() {
  const entered = createDeferredCore();
  const held = createDeferredCore<T>();
  return {
    entered: entered.promise,
    resolve: held.resolve,
    load: vi.fn(async () => {
      entered.resolve();
      return await held.promise;
    }),
  };
}

async function sessionSource(key: string) {
  const { readSource } = await loadGatewaySessionEntryReadOnlyAsync(key, { agentId: "main" });
  if (!readSource) {
    throw new Error(`Missing session PR source: ${key}`);
  }
  return readSource;
}

function closedPull(number?: number) {
  return pullListItem({
    ...(number === undefined
      ? {}
      : { number, html_url: `https://github.com/synthetic/publication/pull/${number}` }),
    state: "closed",
    head: {},
    base: { ref: "main", repo: { name: "publication", owner: { login: "synthetic" } } },
  });
}

async function withDefaultLoader(provider: typeof fetch, run: (f: Fixture) => Promise<void>) {
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      vi.stubGlobal("fetch", provider);
      const f = await createFixture("operator.read", true);
      try {
        await run(f);
      } finally {
        await f.close();
      }
    });
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}

function frames(socket: ReturnType<typeof createGatewayWsTestSocket>) {
  return socket.send.mock.calls.flatMap(([data]) => {
    const frame: unknown = JSON.parse(data.toString());
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

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "prepared session PR transport",
  () => {
    let ownerBroker: SpawnBrokerHost;
    let callerBroker: SpawnBrokerHost;
    beforeAll(async () => {
      ownerBroker = createSpawnBrokerHost();
      callerBroker = createSpawnBrokerHost();
      await Promise.all([ownerBroker.ready(), callerBroker.ready()]);
    });
    afterAll(async () => {
      await Promise.all([ownerBroker?.close(), callerBroker?.close()]);
    });

    it("keeps the owner's spawn broker while detaching the requesting caller", async ({
      signal,
    }) => {
      const callerContext = new AsyncLocalStorage<string>();
      // Shared stores outlive this suite's brokers; only the PR owner captures one.
      sharedState ??= await createOpenClawTestState({ scenario: "minimal" });
      await runWithSpawnBroker(ownerBroker, () =>
        withFixture("operator.read", async (f) => {
          const target = await prepareControlUiSessionPrServiceTarget(
            () => getSessionRowProjection(f.context),
            { sessionKey, agentId: "main" },
          );
          if (!target || target.source === null) {
            throw new Error("Fixture has no workspace PR target");
          }
          const launched = createDeferredCore<{
            parentPid: number;
            caller: string | undefined;
          }>();
          f.load.mockImplementationOnce(async () => {
            try {
              const caller = callerContext.getStore();
              const result = await runExec(process.execPath, ["-p", "process.ppid"], {
                logOutput: false,
                signal,
              });
              launched.resolve({ parentPid: Number(result.stdout.trim()), caller });
              return snapshot;
            } catch (error) {
              launched.reject(error);
              throw error;
            }
          });
          callerContext.run("request-authority", () =>
            runWithSpawnBroker(callerBroker, () => f.subscriptions.readPrepared(target)),
          );
          expect(await withinTest(launched.promise, signal)).toEqual({
            parentPid: ownerBroker.pid,
            caller: undefined,
          });
        }),
      );
    });
  },
);

it.each(["incarnation", "namespace", "repository"] as const)(
  "retires a captured private PR read after its %s changes",
  async (change) => {
    await withFixture(
      "operator.admin",
      async (f) => {
        const key = "agent:main:dashboard:incognito-pr-retirement";
        const repository = await f.seedRepository(
          key,
          "private",
          { incognito: true },
          "private-change",
        );
        const entry = { incognito: true as const, repositoryWorkspaceId: repository.workspaceId };
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
          await awaitGateBeforeSettlement(
            entered.promise,
            loading,
            "Private PR read was not admitted",
          );
          if (change === "repository") {
            await getSessionRepositoryWorkspaceStore().delete({
              workspaceId: repository.workspaceId,
              assertCurrent: () => {},
            });
          } else {
            if (change === "namespace") {
              const source = await sessionSource(key);
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

it.each(["private local", "private repository", "archived", "scoped global"] as const)(
  "delivers an authorized %s session",
  async (kind) => {
    const privateRow = kind.startsWith("private");
    await withFixture(
      privateRow ? "operator.admin" : "operator.read",
      async (f) => {
        const key = privateRow
          ? "agent:main:dashboard:incognito-pr-reader"
          : kind === "scoped global"
            ? "agent:main:global"
            : sessionKey;
        if (privateRow) {
          if (kind === "private repository") {
            await f.seedRepository(key, "private", { incognito: true }, "private-change");
          } else {
            await f.seed(key, f.profile.id, { incognito: true });
          }
        } else if (kind === "scoped global") {
          await f.seed("global");
          await f.seed(key, f.profile.id, { sessionId: "separate-literal-global-row" });
        }
        await f.subscribe([key]);
        await f.subscriptions.pollNow();
        expect(f.load).toHaveBeenCalledWith(
          { sessionKey: kind === "scoped global" ? "global" : key, agentId: "main" },
          expect.any(AbortSignal),
          expect.objectContaining({ assertCurrent: expect.any(Function) }),
        );
        expect(frames(f.socket)).toEqual([expectedFrame(key)]);
        if (privateRow) {
          expect(
            getSessionRowProjection(f.context)
              ?.selectEntries()
              .map((row) => row.key),
          ).not.toContain(key);
        }
      },
      privateRow,
      kind === "archived" ? { archivedAt: 1 } : {},
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
      const captureSource = stateReadWorker.captureOpenClawStateReadSource;
      let held = false;
      const transport = vi
        .spyOn(stateReadWorker, "captureOpenClawStateReadSource")
        .mockImplementation(() => {
          const source = captureSource();
          return {
            ...source,
            createTransport(command) {
              const owned = source.createTransport(command);
              if (held || command.type !== "agentDatabaseDeletion.snapshot") {
                return owned;
              }
              held = true;
              return {
                ...owned,
                async startRead(...args) {
                  const result = await owned.startRead(...args);
                  entered.resolve();
                  await release.promise;
                  return result;
                },
              };
            },
          };
        });
      sessionChanges.emit({ all: true, scope: "stores" });
      const polling = f.subscriptions.pollNow();
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          polling,
          "PR polling finished before its pending topology was prepared",
        );
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
    spyOnSessionPrLoader(load);
    const readSource = createTestSessionPrReadSource();
    const broadcast = vi.fn();
    const subscriptions = createControlUiSessionPullRequestSubscriptions({
      scheduler: createTestGatewayScheduler(),
      broadcastToConnIds: broadcast,
      prepareRead: async (_connId, session) => async () => {
        if (session.sessionKey === first && !ready) {
          entered.resolve();
          await release.promise;
          ready = true;
        }
        return {
          params: { sessionKey: session.sessionKey, agentId: "main" },
          identity: session.sessionKey,
          readSource,
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
      const held = holdLoad<ControlUiSessionPullRequests>();
      f.load.mockImplementationOnce(held.load);
      try {
        await f.subscribe([key]);
        await held.entered;
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

it.each([false, true])(
  "keeps a shared load for an unchanged viewer when the other grant retires (delayed=%s)",
  async (delayed) => {
    try {
      await withFixture("operator.read", async (f) => {
        const held = holdLoad<ControlUiSessionPullRequests>();
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
        f.load.mockImplementationOnce(held.load);
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
            await held.entered;
            await f.subscribe([sessionKey], peer.client);
          }
          f.access.abort(new Error("Original access retired"));
          if (delayed) {
            await f.clock.advanceBy(10_000);
            await held.entered;
            expect(frames(peer.socket), "no refresh result before the held loader settles").toEqual(
              [],
            );
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
      const original = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, {
        agentId: "main",
      });
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

it.each([
  "archived",
  "unchanged",
  "row refresh",
  "source",
  "grant",
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
        : change === "archived"
          ? sessionKey
          : "agent:main:shared-checks";
      if (change === "literal-global-visibility") {
        await f.seed("global", f.profile.id, { sessionId: "separate-global-row" });
      }
      const projection = getSessionRowProjection(f.context);
      if (change === "archived") {
        if (!projection) {
          throw new Error("Missing session projection for archived PR checks");
        }
        expect(projection.snapshot({ agentId: "main", key }).row).toBeDefined();
        sessionChanges.emit({ all: true, scope: "catalog" });
        await projection.ensureMaterialized();
        expect(projection.capture({ agentId: "main", key })?.materialized).toBeUndefined();
      }
      const mutation =
        change === "literal-global" || change === "archived"
          ? "unchanged"
          : change === "literal-global-visibility"
            ? "visibility"
            : change;
      if (change !== "archived") {
        await f.seed(key, f.other.id);
      }
      const target = {
        owner: "synthetic",
        repo: "publication",
        number: 1,
        headSha: "a".repeat(40),
      };
      const params = { sessionKey: key, ...target };
      const result: ControlUiSessionPullRequestCheckDetails = {
        ...target,
        status: "ready",
        rateLimited: false,
        checks: [],
      };
      const held = holdLoad<ControlUiSessionPullRequestCheckDetails>();
      const load = held.load;
      const loadChecks = vi
        .spyOn(checkDetails, "loadControlUiSessionPullRequestChecks")
        .mockImplementation(load);
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
        extraHandlers: controlUiHandlers,
        isWebchatConnect: () => false,
        respond,
      });
      try {
        await awaitGateBeforeSettlement(
          held.entered,
          request,
          "The registered check-details loader was not entered",
        );
        if (mutation === "store closure") {
          await closeOpenClawAgentDatabaseByPathAsync((await sessionSource(key)).path);
        } else if (mutation === "row refresh") {
          sessionChanges.emit({ agentId: "main", sessionKey: key, scope: "session-entry" });
          await projection?.ensureMaterialized();
        } else if (mutation === "source") {
          await f.seed(key, f.other.id, { spawnedCwd: "/synthetic/replacement" });
          await projection?.ensureMaterialized();
        } else if (mutation === "selection") {
          if (!projection) {
            throw new Error("Missing session projection for selection replacement");
          }
          await f.seed(key, f.other.id, { sessionId: "replacement-selection" });
          await projection.ensureMaterialized();
        } else {
          await f.changeReader(mutation, key);
        }
        held.resolve(result);
        await request;
        expect(load).toHaveBeenCalledOnce();
        const allowed = mutation === "unchanged" || mutation === "row refresh";
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          allowed,
          allowed ? result : undefined,
          allowed
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
        loadChecks.mockRestore();
      }
    },
    change === "store closure",
    change === "archived" ? { archivedAt: 1 } : {},
  );
});

it.each(["local", "repository"] as const)(
  "reuses prepared %s rows for warm readers without SQLite freshness polling",
  async (source) => {
    await withFixture("operator.read", async (f) => {
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository = source === "repository" ? await f.seedRepository() : undefined;
      await f.subscribe();
      const read = createControlUiSessionPrRead({
        client: f.client,
        sessionKey,
        getRuntimeConfig: f.context.getRuntimeConfig,
        getSessionRowProjection: () => getSessionRowProjection(f.context),
        isCurrentClient: () => !f.client.invalidated,
      })!;
      const target = await read();
      expect(target).toBeDefined();
      const sorts = vi.spyOn(Array.prototype, "sort");
      try {
        for (let index = 0; index < 3; index++) {
          target!.assertCurrent!();
        }
        expect(sorts).not.toHaveBeenCalled();
      } finally {
        sorts.mockRestore();
      }
      const statements = observeSqliteReadSql(StatementSync.prototype);
      try {
        for (let index = 1; index < 20; index++) {
          await f.subscribe([sessionKey], f.addReader(`warm-reader-${index}`).client);
        }
        await f.subscriptions.pollNow();
        expect(statements.queries.filter((sql) => /\buser_profiles\b/i.test(sql))).toEqual([]);
        statements.queries.length = 0;
        f.load.mockClear();
        for (let index = 0; index < 3; index++) {
          await f.subscriptions.pollNow();
        }
        const queries = statements.queries.map((sql) => sql.toLowerCase());
        expect(
          queries.filter((sql) =>
            /session_nodes|user_profiles|session_repository_workspaces|pragma|cache_generation/.test(
              sql,
            ),
          ),
        ).toEqual([]);
        expect(f.load).toHaveBeenCalledTimes(3);
        expect(frames(f.socket)).toEqual([expectedFrame(sessionKey)]);
      } finally {
        statements.restore();
      }
      if (repository) {
        const previousCache = f.load.mock.calls[0]?.[1];
        expect((await read())?.source).toMatchObject({ repo: "publication" });
        const unavailable = { pullRequests: [], rateLimited: false };
        f.load.mockImplementation(async (_params, _signal, current) =>
          current.target.source === null ? unavailable : snapshot,
        );
        // Read before background preparation can replace the invalidated repository facts.
        const notifiedRead = vi.fn(read);
        const stop = sessionChanges.subscribe((change) => {
          if ("sessionKey" in change && change.sessionKey === sessionKey) {
            void notifiedRead();
          }
        });
        try {
          await repositories.delete({
            workspaceId: repository.workspaceId,
            assertCurrent: () => {},
          });
          expect(notifiedRead).toHaveBeenCalledOnce();
          expect((await notifiedRead.mock.results[0]!.value)?.source).toBeNull();
        } finally {
          stop();
        }
        // Settle the replacement load, then verify another poll emits no stale snapshot.
        await f.subscriptions.pollNow();
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

it("preserves scope order and duplicate multiplicity when checking a retained reader", async () => {
  await withFixture("operator.admin", async (f) => {
    f.client.connect.scopes = ["operator.read", "operator.write", "operator.read"];
    const read = createControlUiSessionPrRead({
      client: f.client,
      sessionKey,
      getRuntimeConfig: f.context.getRuntimeConfig,
      getSessionRowProjection: () => getSessionRowProjection(f.context),
      isCurrentClient: () => !f.client.invalidated,
    })!;
    const target = await read();
    expect(target).toBeDefined();
    expect(f.client.connect.scopes).toEqual(["operator.read", "operator.write", "operator.read"]);
    f.client.connect.scopes = ["operator.write", "operator.read", "operator.read"];
    expect(() => target!.assertCurrent!()).not.toThrow();
    expect(await read()).toBe(target);
    expect(f.client.connect.scopes).toEqual(["operator.write", "operator.read", "operator.read"]);
    f.client.connect.scopes.pop();
    expect(() => target!.assertCurrent!()).toThrow("Session pull-request target changed");
    expect(await read()).toBeUndefined();
  });
});

it("keeps warm default-loader SQL constant as readers join without a native row transaction", async () => {
  const provider = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.pathname.endsWith("/pulls")) {
      return githubJson([closedPull()]);
    }
    throw new Error(`Unexpected warm PR request: ${url.pathname}`);
  });
  await withDefaultLoader(provider, async (f) => {
    await f.seedRepository();
    await f.subscribe();
    await f.subscriptions.pollNow();
    const preparation = vi.spyOn(getSessionRowProjection(f.context)!, "withPreparedExactRows");
    try {
      const read = createControlUiSessionPrRead({
        client: f.client,
        sessionKey,
        getRuntimeConfig: f.context.getRuntimeConfig,
        getSessionRowProjection: () => getSessionRowProjection(f.context),
        isCurrentClient: () => !f.client.invalidated,
      });
      expect(await read?.()).toMatchObject({ sessionId: f.sessionId });
      expect(preparation).toHaveBeenCalledTimes(1);
      preparation.mockClear();
      await f.subscriptions.replace(f.client.connId!, [sessionKey]);
      expect(preparation).not.toHaveBeenCalled();
    } finally {
      preparation.mockRestore();
    }
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
    expect(twentyReaders).toEqual(oneReader);
    expect(oneReader.transactions).toBe(0);
    expect(frames(f.socket)).toHaveLength(1);
    expect(JSON.stringify(frames(f.socket))).toContain('"number":103469');
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

it("drops cached subscription hydration after physical database replacement", async () => {
  let rateLimited = false;
  const provider = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (!url.pathname.endsWith("/pulls")) {
      throw new Error(`Unexpected replacement PR request: ${url.pathname}`);
    }
    return rateLimited
      ? githubJson({ message: "Rate limited" }, 429)
      : githubJson([closedPull(300)]);
  });
  await withDefaultLoader(provider, async (f) => {
    await f.seedRepository();
    await f.subscribe();
    await f.subscriptions.pollNow();
    expect(frames(f.socket)).toMatchObject([
      { payload: { sessions: { [sessionKey]: { pullRequests: [{ number: 300 }] } } } },
    ]);
    const requestsBeforeReplacement = provider.mock.calls.length;
    const source = await sessionSource(sessionKey);
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
  });
});

it.each(["concurrency limit", "earlier refresh", "refresh timer", "publication"] as const)(
  "retires default PR loads queued behind %s",
  async (waitingOn) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const lookedUp: string[] = [];
    const activeLoads = waitingOn === "concurrency limit" ? 4 : 1;
    if (waitingOn === "refresh timer") {
      release.resolve();
    }
    const provider = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith("/pulls")) {
        lookedUp.push(url.pathname);
        if (lookedUp.length === activeLoads) {
          entered.resolve();
        }
        await release.promise;
        return githubJson([pullListItem({ state: "closed", head: {} })]);
      }
      return githubJson({ additions: 1, deletions: 0 });
    });
    await withDefaultLoader(provider, async (f) => {
      try {
        const keys = [];
        for (let index = 0; index < (waitingOn === "concurrency limit" ? 5 : 1); index++) {
          const key = `agent:main:queued-pr-${index}`;
          keys.push(key);
          await f.seedRepository(key, `queued-${index}`);
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
        const source = await sessionSource(keys[0]!);
        let retirement: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
        const peer = waitingOn === "publication" ? f.addReader("publication-peer") : undefined;
        if (peer) {
          await f.subscribe(keys, peer.client);
          f.socket.send.mockImplementationOnce(() => {
            retirement = closeOpenClawAgentDatabaseByPathAsync(source.path);
          });
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(source.path);
        }
        release.resolve();
        const settled = Promise.all([f.subscriptions.pollNow(), queuedRefresh]);
        if (waitingOn === "refresh timer") {
          await f.clock.advanceBy(10_000);
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
      }
    });
  },
);
