import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  getProcessCleanupBudget,
  runWithProcessCleanupBudget,
} from "../process/supervisor/cleanup-budget.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import * as secretStore from "../secrets/store/secret-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const oauth = vi.hoisted(() => ({
  create: vi.fn(),
  install: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("./github-oauth-lifecycle.js", () => ({
  createGitHubOAuthLifecycle: oauth.create,
  installActiveGitHubOAuthLifecycle: oauth.install,
}));

// mock-isolation: Prevent unrelated backfill; real lifetime/worker proof covers publication.
vi.mock("./session-cost-usage-lifetime.js", () => ({
  startSessionCostUsageProjectionLifetime: () => ({ stop: async () => {} }),
}));

const roots: string[] = [];

function nextTurn(channel: MessageChannel): Promise<void> {
  return new Promise((resolve) => {
    channel.port1.once("message", () => resolve());
    channel.port2.postMessage(null);
  });
}

function sidecarFixture() {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const owner = createGatewaySidecarStopOwner();
  return {
    clock,
    scheduler,
    owner,
    attach: (overrides: Partial<Parameters<typeof attachInitialGatewayLifetimeSidecars>[0]> = {}) =>
      attachInitialGatewayLifetimeSidecars({
        scheduler,
        chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
        gatewayRequestContext: {} as never,
        flushPendingSessionsChangedEvents: vi.fn(),
        minimalTestGateway: false,
        logWarning: vi.fn(),
        publishSidecars: owner.publish,
        ...overrides,
      }),
  };
}

function createStateDir(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecars-")));
  roots.push(root);
  return root;
}

async function writeStoredSecret(name: string, value: string): Promise<void> {
  await writeSecretStoreEntry({
    scope: { kind: "team" },
    name,
    value,
    kind: "secret",
    allowedHosts: [],
    updatedBy: "test",
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("gateway lifetime sidecars", () => {
  beforeEach(() => {
    oauth.start.mockReset();
    oauth.stop.mockReset().mockResolvedValue(undefined);
    oauth.uninstall.mockReset();
    oauth.create.mockReset().mockReturnValue({ start: oauth.start, stop: oauth.stop });
    oauth.install.mockReset().mockReturnValue(oauth.uninstall);
  });

  test("parks empty expiry, resumes on writes, and joins responsive worker sweeps on shutdown", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
      const { clock, owner, attach } = sidecarFixture();
      const sweeps: Promise<number>[] = [];
      const purge = secretStore.purgeExpiredSecretStoreEntries;
      const openingMessages = vi.spyOn(Worker.prototype, "postMessage");
      const observePurge = vi
        .spyOn(secretStore, "purgeExpiredSecretStoreEntries")
        .mockImplementation((...args) => {
          const result = purge(...args);
          sweeps.push(Promise.resolve(result));
          return result;
        });
      await attach();
      await clock.wake();
      expect(await Promise.all(sweeps)).toEqual([0]);
      const context = captureOpenClawStateWorkerContext();
      const openIndex = openingMessages.mock.calls.findIndex(([message]) => {
        const request = asOptionalRecord(message);
        return request?.type === "open" && request.databasePath === context.admission.databasePath;
      });
      const worker = openingMessages.mock.contexts[openIndex];
      openingMessages.mockRestore();
      assert(worker instanceof Worker);
      await clock.advanceBy(5 * 60_000);
      expect(sweeps).toHaveLength(1);
      const handoff = "github-setup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      await writeStoredSecret(handoff, "synthetic-expired-handoff");
      await clock.wake();
      expect(await Promise.all(sweeps)).toEqual([0, 0]);
      expect(secretStore.getSecretStoreExpiryDeadline()).toEqual(expect.any(Number));
      await writeStoredSecret(handoff, "synthetic-expired-handoff");
      openOpenClawStateDatabase()
        .db.prepare("UPDATE secret_store_entries SET created_at_ms = ? WHERE name = ?")
        .run(Date.now() - 11 * 60_000, handoff);
      const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 5_000);
      const hostYielded = createDeferred<number>();
      const checkpoint = new MessageChannel();
      checkpoint.port1.once("message", () => hostYielded.resolve(Atomics.load(holder.released, 0)));
      const dispatched = createDeferred();
      const post = worker.postMessage.bind(worker);
      const observeDispatch = vi
        .spyOn(worker, "postMessage")
        .mockImplementation((message, transferList) => {
          const request = asOptionalRecord(message);
          if (
            request?.type === "execute" &&
            request.input instanceof Uint8Array &&
            asOptionalRecord(deserialize(request.input))?.type === "secrets.purge"
          ) {
            dispatched.resolve();
          }
          return post(message, transferList);
        });
      let stopping: Promise<void> | undefined;
      let scheduledSweep: void | Promise<void> = undefined;
      try {
        await holder.ready;
        checkpoint.port2.postMessage(null);
        scheduledSweep = clock.wake();
        await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
          expect(
            await withTestTimeout(hostYielded.promise, 10_000, "Expiry did not yield to the host"),
          ).toBe(0);
          await withTestTimeout(
            dispatched.promise,
            5_000,
            "Expiry did not reach its shared-state worker",
          );
          await clock.advanceBy(60_000);
          expect(sweeps).toHaveLength(3);
          const stopped = vi.fn();
          stopping = owner.stop().then(stopped);
          await withTestTimeout(nextTurn(checkpoint), 5_000, "Shutdown did not yield to the host");
          expect(stopped).not.toHaveBeenCalled();
          expect(Atomics.load(holder.released, 0)).toBe(0);
          holder.release();
          await expect(holder.joined).resolves.toBe(0);
          await stopping;
          await scheduledSweep;
          expect(await sweeps[2]).toBe(1);

          await clock.advanceBy(60_000);
          expect(sweeps).toHaveLength(3);
        });
        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
            .get(handoff),
        ).toEqual({ count: 0 });
      } finally {
        checkpoint.port1.close();
        checkpoint.port2.close();
        holder.release();
        await Promise.allSettled([...sweeps, holder.joined, stopping, scheduledSweep]);
        await owner.stop();
        observeDispatch.mockRestore();
        observePurge.mockRestore();
      }
    });
  });

  test("does not sweep secrets in a minimal gateway", async () => {
    const { clock, owner, attach } = sidecarFixture();
    vi.spyOn(secretStore, "getSecretStoreExpiryDeadline").mockReturnValue(null);
    const purge = vi.spyOn(secretStore, "purgeExpiredSecretStoreEntries").mockResolvedValue(0);
    try {
      await attach({ minimalTestGateway: true });
      await clock.wake();
      await clock.advanceBy(60_000);
      expect(purge).not.toHaveBeenCalled();
    } finally {
      await owner.stop();
    }
  });

  test.each(["before", "after"])("owns sidecars published %s shutdown begins", async (timing) => {
    const owner = createGatewaySidecarStopOwner();
    const budget = { deadline: 10_000, warn: vi.fn() };
    const sidecar = () => ({
      stop: vi.fn(async () => {
        expect(getProcessCleanupBudget()).toBe(budget);
      }),
    });
    const metadataListener = sidecar();
    const sessionChange = sidecar();
    const worker = sidecar();
    if (timing === "after") {
      await runWithProcessCleanupBudget(budget, () => owner.stop());
    }
    owner.publish(metadataListener, sessionChange);
    owner.publish(worker, metadataListener);
    expect(owner.snapshot()).toEqual([metadataListener, sessionChange, worker]);
    if (timing === "before") {
      await runWithProcessCleanupBudget(budget, () => owner.stop());
    }
    await owner.sealAndJoin();
    for (const entry of [metadataListener, sessionChange, worker]) {
      expect(entry.stop).toHaveBeenCalledOnce();
    }
  });

  test("joins session events admitted after the initial sidecar drain", async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:late";
    const projection = createSessionRowProjectionFixture({
      cfg,
      agentId: "main",
      store: { [sessionKey]: { sessionId: "late", updatedAt: 1 } },
    });
    vi.useFakeTimers();
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => cfg,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      ...bindSessionRowProjection({}, () => projection),
    } as unknown as GatewayRequestContext;
    const prepared = createDeferred();
    const prepare = projection.withPreparedExactRows.bind(projection);
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(async (queries, consume) => {
      await prepared.promise;
      return prepare(queries, consume);
    });
    const { owner, attach } = sidecarFixture();
    try {
      await attach({
        scheduler: createTestGatewayScheduler(),
        gatewayRequestContext: context,
        flushPendingSessionsChangedEvents,
        minimalTestGateway: true,
      });
      await owner.stop();
      emitSessionsChanged(context, { reason: "patch", sessionKey });
      const sealed = vi.fn();
      const seal = owner.sealAndJoin().then(sealed);
      await vi.advanceTimersByTimeAsync(0);
      const sealedBeforePublication = sealed.mock.calls.length;
      prepared.resolve();
      await seal;
      await flushPendingSessionsChangedEvents(context);
      expect(sealedBeforePublication).toBe(0);
      emitSessionsChanged(context, { reason: "patch", sessionKey });
      await vi.advanceTimersByTimeAsync(0);
      expect(context.broadcastToConnIds).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      prepared.resolve();
      await flushPendingSessionsChangedEvents(context);
      projection.dispose();
    }
  });

  test("owns and joins GitHub publication recovery when worker placement is unavailable", async () => {
    const { clock, scheduler, owner, attach } = sidecarFixture();
    const entered = createDeferred();
    const release = createDeferred();
    const reconcileGitHubPublications = vi
      .fn(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      });
    const checkpoint = new MessageChannel();
    const warn = vi.fn();
    vi.spyOn(secretStore, "getSecretStoreExpiryDeadline").mockReturnValue(null);
    vi.spyOn(secretStore, "purgeExpiredSecretStoreEntries").mockResolvedValue(0);

    await attach({ logWarning: warn, reconcileGitHubPublications });
    let scheduled: void | Promise<void> = undefined;
    let stopping: Promise<void> | undefined;
    try {
      await clock.wake();
      expect(reconcileGitHubPublications).toHaveBeenCalledOnce();

      scheduled = clock.advanceBy(60_000);
      await entered.promise;
      await clock.advanceBy(3 * 60_000);
      expect(reconcileGitHubPublications).toHaveBeenCalledTimes(2);
      const stopped = vi.fn();
      stopping = owner.stop().then(stopped);
      await nextTurn(checkpoint);
      expect(stopped).not.toHaveBeenCalled();
      release.reject(new Error("synthetic publication recovery failure"));
      await Promise.all([scheduled, stopping]);
      expect(stopped).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("GitHub publication recovery failed; will retry.");

      await clock.advanceBy(60_000);
      expect(reconcileGitHubPublications).toHaveBeenCalledTimes(2);
    } finally {
      checkpoint.port1.close();
      checkpoint.port2.close();
      release.resolve();
      await Promise.allSettled([scheduled, stopping]);
      await owner.stop();
      await scheduler.stop();
    }
  });

  test("attaches and retires authorization lifecycles with the Gateway", async () => {
    const { owner, attach } = sidecarFixture();
    const context: Pick<
      GatewayRequestContext,
      "getRuntimeConfig" | "githubOAuthService" | "modelAccountConnectService"
    > = {
      getRuntimeConfig: vi.fn(() => ({})),
    };
    const warn = vi.fn();

    await attach({
      scheduler: createTestGatewayScheduler(),
      gatewayRequestContext: context as never,
      logWarning: warn,
    });

    expect(oauth.create).toHaveBeenCalledWith({
      scheduler: expect.any(GatewayScheduler),
      getConfig: context.getRuntimeConfig,
      getPersistedConfig: expect.any(Function),
      warn,
    });
    expect(oauth.install).toHaveBeenCalledWith(context.githubOAuthService);
    expect(oauth.start).toHaveBeenCalledOnce();
    expect(context.githubOAuthService).toBeDefined();
    expect(context.modelAccountConnectService).toBeDefined();
    const modelAccounts = context.modelAccountConnectService;

    await owner.stop();
    expect(oauth.uninstall).toHaveBeenCalledOnce();
    expect(oauth.stop).toHaveBeenCalledOnce();
    expect(context.githubOAuthService).toBeUndefined();
    expect(context.modelAccountConnectService).toBeUndefined();
    await expect(
      modelAccounts?.statusAsync({ owner: "profile-1", assertCurrent: () => {} }, "stale-flow"),
    ).rejects.toThrow("current authorized connection");
  });
});
