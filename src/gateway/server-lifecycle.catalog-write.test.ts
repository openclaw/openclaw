import "./server-startup-module-mocks.test-support.js";
import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import * as bundledStamp from "../model-catalog/bundled-catalog-stamp.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
} from "../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../sessions/session-upstream-links.js";
import { readSessionUpstreamLinkInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { connectUserModelAccount, readUserModelAuthProfile } from "../state/user-model-accounts.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";
import {
  withLocalWorkspaceStore,
  type LocalWorkspaceStore,
} from "./worker-environments/local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-store.test-support.js";

const { installGatewaySubagentModuleLoad } =
  await import("./server-startup-module-mocks.test-support.js");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});
async function prepareClosingGateway(signal: AbortSignal) {
  const name = "gateway-catalog-write-close";
  const fixture = await createGatewayMetadataCloseFixture(name);
  const release = createDeferredCore();
  const pending: Promise<unknown>[] = [];
  const startupModuleRestorers: Array<() => void> = [];
  cleanups.push(async () => {
    release.resolve();
    try {
      await Promise.allSettled(pending);
      vi.restoreAllMocks();
      await fixture.cleanup();
    } finally {
      for (const restore of startupModuleRestorers.toReversed()) {
        restore();
      }
    }
  });
  const port = await fixture.reservePort();
  const server = await fixture.start(port);
  const kernel = fixture.kernels.get(port);
  assert(kernel);
  const options = { env: fixture.state.env };
  const shared = openOpenClawStateDatabase(options).db;
  const accepted = createDeferredCore();
  const track = <T>(task: Promise<T>) => {
    pending.push(task);
    return task;
  };
  return {
    fixture,
    port,
    kernel,
    options,
    shared,
    accepted,
    release,
    startupModuleRestorers,
    track,
    trackConnection<T>(run: () => Promise<T>) {
      return track(kernel.connectionWork.track(run));
    },
    sql: (query: string) => openOpenClawStateDatabase(options).db.prepare(query),
    holdCommand(type: string) {
      probe.command(stateWorker, async (command, executeOptions, scope) => {
        if (command.type === type) {
          accepted.resolve();
          await release.promise;
        }
        return scope.execute(command, executeOptions);
      });
    },
    async admitted(task: Promise<unknown>, message: string) {
      await withinTest(awaitGateBeforeSettlement(accepted.promise, task, message), signal);
    },
    async beginClose(abortSignal = kernel.connectionWork.signal) {
      const parentClosed = createDeferredCore();
      abortSignal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
      const closing = track(server.close({ reason: name }));
      await withinTest(parentClosed.promise, signal);
      return { closing };
    },
  };
}

it("persists accepted catalog writes before closing the state writer", async ({ signal }) => {
  const context = await prepareClosingGateway(signal);
  const { fixture, kernel, shared, release } = context;
  const lifecycle = createGatewayUpdateLifecycle(kernel.scheduler);
  kernel.runtimeState.stopGatewayUpdateCheck = lifecycle.stop;
  const bundle = {
    schemaVersion: 2,
    sourceCommit: "synthetic",
    generatedAt: 1_753_500_000_000,
    providers: { anthropic: {} },
    models: [{ id: "catalog-close", provider: "anthropic", pricing: { status: "unknown" } }],
  };
  context.holdCommand("modelCatalog.remote.write");
  vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockReturnValue(bundle.generatedAt - 1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(bundle))),
  );
  const refreshing = context.track(
    lifecycle.run((catalogSignal) =>
      refreshRemoteModelCatalog({
        config: {},
        force: true,
        signal: catalogSignal,
        databaseOptions: { env: fixture.state.env },
      }),
    ),
  );
  await context.admitted(refreshing, "Catalog refresh settled before worker write");
  const { closing } = await context.beginClose(kernel.scheduler.signal);
  expect(lifecycle.signal.aborted).toBe(true);
  const lateWork = vi.fn(async () => undefined);
  await expect(lifecycle.run(lateWork)).rejects.toThrow();
  expect(lateWork).not.toHaveBeenCalled();
  expect(shared.isOpen).toBe(true);
  release.resolve();
  await expect(refreshing).resolves.toMatchObject({
    status: "updated",
    generatedAt: bundle.generatedAt,
  });
  await closing;
  expect(shared.isOpen).toBe(false);
  expect(
    JSON.parse(readRemoteModelCatalog({ env: fixture.state.env })?.bundle_json ?? "null"),
  ).toEqual(bundle);
});

it("joins notice cleanup and upstream deletion after close prelude", async ({ signal }) => {
  const context = await prepareClosingGateway(signal);
  const { fixture, port, kernel, options, shared, release, sql } = context;
  const watcher = "agent:main:subagent:startup-notice-watcher";
  const target = "agent:main:subagent:startup-notice-target";
  await upsertSessionEntryCore(
    { sessionKey: watcher, env: fixture.state.env },
    { sessionId: "startup-notice-watcher", updatedAt: Date.now() },
  );
  sql(
    `INSERT INTO session_watch_cursors
         (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
          notified_sequence, material_sequence, updated_at)
         VALUES (?, ?, ?, 1, 2, 3, ?)`,
  ).run(
    watcher,
    target,
    resolvePhysicalSessionStorePath({ sessionKey: watcher, env: fixture.state.env }),
    Date.now(),
  );
  context.holdCommand("sessionState.sweep");
  const logs = { info() {}, warn() {}, error() {} };
  await installGatewaySubagentModuleLoad(
    async () => {},
    async () => {},
    context.startupModuleRestorers,
  );
  const sentinel = vi
    .spyOn(await import("./server-update-sentinel.js"), "prepareLatestUpdateRestartSentinel")
    .mockResolvedValue(null);
  context.startupModuleRestorers.push(() => sentinel.mockRestore());
  // Startup tracks the original promise without lending its connection scope to storage.
  const operation = Promise.resolve().then(() =>
    runGatewayStartupObservers({
      registry: createEmptyPluginRegistry(),
      resolveGatewayContext: () => undefined,
      loadSubagentRegistryActivation: async () =>
        (await import("../agents/subagents/registry/subagent-registry.js"))
          .activateSubagentRegistry,
      createHookRunner: async (...args) =>
        (await import("../plugins/hooks.js")).createHookRunner(...args),
      refreshLatestUpdateRestartSentinel: async () =>
        (await import("./server-update-sentinel.js")).prepareLatestUpdateRestartSentinel(
          fixture.state.env,
        ),
      signal: kernel.connectionWork.signal,
      port,
      config: fixture.config,
      workspaceDir: fixture.state.workspaceDir,
      getCron: () => undefined,
      isClosing: () => kernel.lifecycle.closePreludeStarted,
      log: logs,
      logHooks: logs,
    }),
  );
  const sweeping = context.trackConnection(() => operation);
  await context.admitted(sweeping, "Startup observers settled before notice write");
  const resetWatcher = `${watcher}-reset`;
  const deletedTarget = `${target}-deleted`;
  expect(
    upsertSessionUpstreamLink(
      {
        sessionKey: deletedTarget,
        agentId: "main",
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "close",
        upstreamKind: "codex-app-server",
        upstreamRef: null,
        marker: null,
      },
      options,
    ),
  ).toBe(true);
  sql(
    "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, ?)",
  ).run(resetWatcher, target, Date.now());
  sql(
    "INSERT INTO session_state_events (session_key, agent_id, kind, actor_type, occurred_at, summary) VALUES (?, 'main', 'adopted', 'human', ?, 'accepted deletion')",
  ).run(deletedTarget, Date.now());
  let cleanupSettled = false;
  const cleaning = context.trackConnection(async () => {
    await handleSessionStateSessionReset(resetWatcher, options);
    await handleSessionStateSessionDeleted(deletedTarget, "main", options);
    cleanupSettled = true;
  });
  const { closing } = await context.beginClose();
  expect(kernel.scheduler.signal.aborted).toBe(true);
  expect(shared.isOpen).toBe(true);
  expect(cleanupSettled).toBe(false);
  release.resolve();
  await Promise.all([sweeping, cleaning]);
  await closing;
  expect(shared.isOpen).toBe(false);
  expect(
    sql(
      "SELECT notified_sequence FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
    ).get(watcher, target),
  ).toEqual({ notified_sequence: 3 });
  const reopened = openOpenClawStateDatabase(options).db;
  expect([
    readSessionUpstreamLinkInDatabase(reopened, deletedTarget, "main"),
    sql("SELECT 1 FROM session_watch_cursors WHERE watcher_session_key = ?").get(resetWatcher),
    sql("SELECT 1 FROM session_state_events WHERE session_key = ?").get(deletedTarget),
  ]).toEqual([undefined, undefined, undefined]);
});

it("joins workspace writes and releases leases after close prelude", async ({ signal }) => {
  let custody: LocalWorkspaceStore | undefined;
  const worktreeId = "local-workspace-close";
  const expectedProjection = { worktree_id: worktreeId, revision: 0 };
  const context = await prepareClosingGateway(signal);
  const { fixture, kernel, options, shared, release, sql } = context;
  context.holdCommand("localWorkspace.mutate");
  const writing = context.trackConnection(() =>
    withLocalWorkspaceStore({ worktreeId, ...options }, async (store) => {
      custody = store;
      return store.create(localWorkspaceProjectionFixture(worktreeId, fixture.state.workspaceDir));
    }),
  );
  await context.admitted(writing, "Workspace write settled before admission");
  const { closing } = await context.beginClose();
  expect(kernel.scheduler.signal.aborted).toBe(true);
  const lateWork = vi.fn(async () => undefined);
  await expect(
    withLocalWorkspaceStore({ worktreeId: "late-workspace", ...options }, lateWork),
  ).rejects.toThrow("run-end admission is closed");
  expect(lateWork).not.toHaveBeenCalled();
  expect(shared.isOpen).toBe(true);
  release.resolve();
  await expect(writing).resolves.toMatchObject(expectedProjection);
  await closing;
  expect(shared.isOpen).toBe(false);
  assert(custody);
  expect(custody.assertCurrent).toThrow();
  expect(await readLocalWorkspaceProjection(worktreeId, fixture.state.env)).toMatchObject(
    expectedProjection,
  );
  expect(
    sql("SELECT count(*) AS count FROM state_leases WHERE scope = ? AND lease_key = ?").get(
      "workspace.local-reconciliation",
      worktreeId,
    ),
  ).toEqual({ count: 0 });
});

it.for(["personal", "shared-peer"] as const)(
  "joins %s OAuth settlement after the close prelude cancels its observer",
  async (kind, { signal }) => {
    const context = await prepareClosingGateway(signal);
    const { fixture, kernel, shared, accepted, release } = context;
    const owner = ensureProfileForEmail("close-personal@example.test");
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "synthetic",
      access: "synthetic-close-old",
      refresh: "synthetic-refresh-old",
      expires: 1,
    };
    const peerDir = fixture.state.agentDir("peer");
    const profileId =
      kind === "personal"
        ? connectUserModelAccount({
            ownerProfileId: owner.id,
            credential,
            assertCurrent() {},
          }).authProfileId
        : "synthetic:shared";
    if (kind === "shared-peer") {
      const store = { version: 1, profiles: { [profileId]: credential } };
      saveAuthProfileStore(store, peerDir);
      saveAuthProfileStore(store);
    }
    const replacement = {
      ...credential,
      access: "synthetic-close-new",
      refresh: "synthetic-refresh-new",
      expires: Date.now() + 600_000,
    };
    const manager = createOAuthManager({
      canRefreshCredential: async () => true,
      refreshCredential: async () => {
        accepted.resolve();
        await release.promise;
        return replacement;
      },
      buildApiKey: async (_provider, value) => value.access,
      readBootstrapCredential: () => null,
    });
    const resolving = context
      .trackConnection(() =>
        manager.resolveOAuthAccess({
          profileId,
          credential,
          store: { version: 1, profiles: { [profileId]: credential } },
          signal: kernel.connectionWork.signal,
        }),
      )
      .catch((error: unknown) => error);
    await context.admitted(resolving, "Refresh did not acquire its durable claim");
    const { closing } = await context.beginClose();
    expect(await resolving).toBeInstanceOf(Error);
    expect(shared.isOpen).toBe(true);
    release.resolve();
    await closing;
    expect(shared.isOpen).toBe(false);
    if (kind === "personal") {
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
    } else {
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(replacement);
      expect(loadPersistedAuthProfileStore(peerDir)?.profiles[profileId]).toBeUndefined();
    }
  },
);
