import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
} from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import "../test-utils/prepare-compiled-subprocesses.js";
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

it("settles an accepted catalog refresh before Gateway close retires its state writer", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-catalog-write-close");
  const accepted = createDeferredCore();
  const release = createDeferredCore();
  const parentClosed = createDeferredCore();
  let refreshing: ReturnType<typeof refreshRemoteModelCatalog> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const lifecycle = createGatewayUpdateLifecycle(kernel.scheduler);
    kernel.runtimeState.stopGatewayUpdateCheck = lifecycle.stop;
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const bundle = {
      schemaVersion: 2,
      sourceCommit: "synthetic",
      generatedAt: 1_753_500_000_000,
      providers: { anthropic: {} },
      models: [{ id: "catalog-close", provider: "anthropic", pricing: { status: "unknown" } }],
    };
    const run = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, options) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "modelCatalog.remote.write") {
                  accepted.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          options,
        ),
    );
    refreshing = lifecycle.run((catalogSignal) =>
      refreshRemoteModelCatalog({
        config: {},
        force: true,
        signal: catalogSignal,
        databaseOptions: { env: fixture.state.env },
        bundledGeneratedAt: () => bundle.generatedAt - 1,
        fetchImpl: async () => new Response(JSON.stringify(bundle)),
      }),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        accepted.promise,
        refreshing,
        "Catalog refresh settled before handing its accepted write to the state worker",
      ),
      signal,
    );
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), {
      once: true,
    });
    closing = server.close({ reason: "catalog write close regression" });
    await withinTest(parentClosed.promise, signal);
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
  } finally {
    release.resolve();
    await Promise.allSettled([refreshing, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

it("joins accepted notice persistence and signal cleanup after the Gateway close prelude aborts", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-notice-sweep-close");
  const accepted = createDeferredCore();
  const release = createDeferredCore();
  const parentClosed = createDeferredCore();
  let sweeping: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const watcher = "agent:main:subagent:startup-notice-watcher";
    const target = "agent:main:subagent:startup-notice-target";
    await upsertSessionEntryCore(
      { sessionKey: watcher, env: fixture.state.env },
      { sessionId: "startup-notice-watcher", updatedAt: Date.now() },
    );
    const options = { env: fixture.state.env };
    const shared = openOpenClawStateDatabase(options).db;
    shared
      .prepare(
        `INSERT INTO session_watch_cursors
         (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
          notified_sequence, material_sequence, updated_at)
         VALUES (?, ?, ?, 1, 2, 3, ?)`,
      )
      .run(
        watcher,
        target,
        resolvePhysicalSessionStorePath({ sessionKey: watcher, env: fixture.state.env }),
        Date.now(),
      );
    const run = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, operationOptions) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "sessionState.sweep") {
                  accepted.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          operationOptions,
        ),
    );
    const logs = { info() {}, warn() {}, error() {} };
    // Startup tracks the original promise without lending its connection scope to storage.
    const operation = Promise.resolve().then(() =>
      runGatewayStartupObservers({
        registry: createEmptyPluginRegistry(),
        resolveGatewayContext: () => undefined,
        loadSubagentRegistryActivation: async () => () => {},
        signal: kernel.connectionWork.signal,
        port,
        config: fixture.config,
        workspaceDir: fixture.state.workspaceDir,
        getCron: () => undefined,
        isClosing: () => kernel.lifecycle.closePreludeStarted,
        log: logs,
        logHooks: logs,
        createHookRunner,
        refreshLatestUpdateRestartSentinel: async () => {},
      }),
    );
    sweeping = kernel.connectionWork.track(() => operation);
    await withinTest(
      awaitGateBeforeSettlement(
        accepted.promise,
        sweeping,
        "Startup observers settled before their notice write reached the state worker",
      ),
      signal,
    );
    const resetWatcher = `${watcher}-reset`;
    const deletedTarget = `${target}-deleted`;
    shared
      .prepare(
        "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, ?)",
      )
      .run(resetWatcher, target, Date.now());
    shared
      .prepare(
        "INSERT INTO session_state_events (session_key, agent_id, kind, actor_type, occurred_at, summary) VALUES (?, 'main', 'adopted', 'human', ?, 'accepted deletion')",
      )
      .run(deletedTarget, Date.now());
    let cleanupSettled = false;
    cleaning = kernel.connectionWork.track(async () => {
      await handleSessionStateSessionReset(resetWatcher, options);
      await handleSessionStateSessionDeleted(deletedTarget, "main", options);
      cleanupSettled = true;
    });
    kernel.connectionWork.signal.addEventListener("abort", () => parentClosed.resolve(), {
      once: true,
    });
    closing = server.close({ reason: "startup notice close regression" });
    await withinTest(parentClosed.promise, signal);
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(cleanupSettled).toBe(false);
    release.resolve();
    await Promise.all([sweeping, cleaning]);
    await closing;
    expect(shared.isOpen).toBe(false);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT notified_sequence FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
        )
        .get(watcher, target),
    ).toEqual({ notified_sequence: 3 });
    const reopened = openOpenClawStateDatabase(options).db;
    expect(
      reopened
        .prepare("SELECT 1 FROM session_watch_cursors WHERE watcher_session_key = ?")
        .get(resetWatcher),
    ).toBeUndefined();
    expect(
      reopened
        .prepare("SELECT 1 FROM session_state_events WHERE session_key = ?")
        .get(deletedTarget),
    ).toBeUndefined();
  } finally {
    release.resolve();
    await Promise.allSettled([sweeping, cleaning, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

it("joins accepted workspace persistence and releases its lease after the Gateway close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-workspace-write-close");
  const accepted = createDeferredCore();
  const release = createDeferredCore();
  const parentClosed = createDeferredCore();
  let writing: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let custody: LocalWorkspaceStore | undefined;
  const worktreeId = "local-workspace-close";
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const options = { env: fixture.state.env };
    const shared = openOpenClawStateDatabase(options).db;
    const run = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
      (context, operation, operationOptions) =>
        run(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                if (command.type === "localWorkspace.mutate") {
                  accepted.resolve();
                  await release.promise;
                }
                return scope.execute(command, executeOptions);
              },
            }),
          operationOptions,
        ),
    );
    writing = kernel.connectionWork.track(() =>
      withLocalWorkspaceStore({ worktreeId, ...options }, async (store) => {
        custody = store;
        return store.create(
          localWorkspaceProjectionFixture(worktreeId, fixture.state.workspaceDir),
        );
      }),
    );
    await withinTest(
      awaitGateBeforeSettlement(
        accepted.promise,
        writing,
        "Workspace write settled before admission",
      ),
      signal,
    );
    kernel.connectionWork.signal.addEventListener("abort", () => parentClosed.resolve(), {
      once: true,
    });
    closing = server.close({ reason: "workspace write close regression" });
    await withinTest(parentClosed.promise, signal);
    expect(kernel.scheduler.signal.aborted).toBe(true);
    const lateWork = vi.fn(async () => undefined);
    await expect(
      withLocalWorkspaceStore({ worktreeId: "late-workspace", ...options }, lateWork),
    ).rejects.toThrow("run-end admission is closed");
    expect(lateWork).not.toHaveBeenCalled();
    expect(shared.isOpen).toBe(true);
    release.resolve();
    await expect(writing).resolves.toMatchObject({ worktree_id: worktreeId, revision: 0 });
    await closing;
    expect(shared.isOpen).toBe(false);
    assert(custody);
    expect(custody.assertCurrent).toThrow();
    expect(await readLocalWorkspaceProjection(worktreeId, fixture.state.env)).toMatchObject({
      worktree_id: worktreeId,
      revision: 0,
    });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT count(*) AS count FROM state_leases WHERE scope = ? AND lease_key = ?")
        .get("workspace.local-reconciliation", worktreeId),
    ).toEqual({ count: 0 });
  } finally {
    release.resolve();
    await Promise.allSettled([writing, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});
