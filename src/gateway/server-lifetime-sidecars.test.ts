import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
import { holdStateDatabaseCoordinator } from "../test-utils/state-database-contention.js";
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

const roots: string[] = [];

function createStateDir(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecars-")));
  roots.push(root);
  return root;
}

function countStoredRows(name: string): number {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
    .get(name) as { count: number };
  return row.count;
}

function writeStoredSecret(name: string, value: string): void {
  writeSecretStoreEntry({
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
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("gateway lifetime sidecars", () => {
  beforeEach(() => {
    oauth.start.mockReset();
    oauth.stop.mockReset().mockResolvedValue(undefined);
    oauth.uninstall.mockReset();
    oauth.create.mockReset().mockReturnValue({
      start: oauth.start,
      stop: oauth.stop,
    });
    oauth.install.mockReset().mockReturnValue(oauth.uninstall);
  });

  test("keeps scheduled secret expiry responsive and joins its accepted sweep on shutdown", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const owner = createGatewaySidecarStopOwner();
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
      await attachInitialGatewayLifetimeSidecars({
        chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
        gatewayRequestContext: {} as never,
        flushPendingSessionsChangedEvents: vi.fn(),
        minimalTestGateway: false,
        logWarning: vi.fn(),
        publishSidecars: owner.publish,
      });
      expect(await Promise.all(sweeps)).toEqual([0]);
      const context = captureOpenClawStateWorkerContext();
      const openIndex = openingMessages.mock.calls.findIndex(([message]) => {
        const request = asOptionalRecord(message);
        return request?.type === "open" && request.databasePath === context.admission.databasePath;
      });
      const worker = openingMessages.mock.contexts[openIndex];
      openingMessages.mockRestore();
      const handoff = "github-setup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      writeStoredSecret(handoff, "synthetic-expired-handoff");
      openOpenClawStateDatabase()
        .db.prepare("UPDATE secret_store_entries SET created_at_ms = ? WHERE name = ?")
        .run(Date.now() - 11 * 60_000, handoff);
      const holder = holdStateDatabaseCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        5_000,
      );
      const hostYielded = createDeferred<number>();
      const checkpoint = new MessageChannel();
      checkpoint.port1.once("message", () => hostYielded.resolve(Atomics.load(holder.released, 0)));
      const dispatched = createDeferred();
      const post = worker instanceof Worker ? worker.postMessage.bind(worker) : undefined;
      const observeDispatch =
        worker instanceof Worker && post
          ? vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
              const request = asOptionalRecord(message);
              if (
                request?.type === "execute" &&
                request.input instanceof Uint8Array &&
                asOptionalRecord(deserialize(request.input))?.type === "secrets.purge"
              ) {
                dispatched.resolve();
              }
              return post(message, transferList);
            })
          : undefined;
      let stopping: Promise<void> | undefined;
      try {
        await holder.ready;
        checkpoint.port2.postMessage(null);
        vi.advanceTimersByTime(60_000);
        await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
          expect(
            await withTestTimeout(hostYielded.promise, 10_000, "Expiry did not yield to the host"),
          ).toBe(0);
          expect(worker).toBeInstanceOf(Worker);
          await withTestTimeout(
            dispatched.promise,
            5_000,
            "Expiry did not reach its shared-state worker",
          );
          vi.advanceTimersByTime(60_000);
          expect(sweeps).toHaveLength(2);
          let stopped = false;
          stopping = owner.stop().then(() => {
            stopped = true;
          });
          const stopCheckpoint = createDeferred();
          checkpoint.port1.once("message", () => stopCheckpoint.resolve());
          checkpoint.port2.postMessage(null);
          await withTestTimeout(
            stopCheckpoint.promise,
            5_000,
            "Shutdown did not yield to the host",
          );
          expect(stopped).toBe(false);
          expect(Atomics.load(holder.released, 0)).toBe(0);
          holder.release();
          await expect(holder.joined).resolves.toBe(0);
          await stopping;
          expect(await sweeps[1]).toBe(1);

          vi.advanceTimersByTime(60_000);
          expect(sweeps).toHaveLength(2);
        });
        expect(countStoredRows(handoff)).toBe(0);
      } finally {
        checkpoint.port1.close();
        checkpoint.port2.close();
        holder.release();
        await Promise.allSettled([...sweeps, holder.joined, stopping]);
        await owner.stop();
        observeDispatch?.mockRestore();
        observePurge.mockRestore();
      }
    });
  });

  test("keeps pre-published sidecars reachable by shutdown", async () => {
    const metadataListener = { stop: vi.fn(async () => {}) };
    const sessionChange = { stop: vi.fn(async () => {}) };
    const worker = { stop: vi.fn(async () => {}) };

    const owner = createGatewaySidecarStopOwner();
    owner.publish(metadataListener, sessionChange);
    owner.publish(worker, metadataListener);
    expect(owner.snapshot()).toEqual([metadataListener, sessionChange, worker]);

    await owner.stop();
    expect(metadataListener.stop).toHaveBeenCalledOnce();
    expect(sessionChange.stop).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });

  test("joins session events admitted after the initial sidecar drain", async () => {
    const sessionKey = "agent:main:late";
    const projection = createSessionRowProjectionFixture({
      cfg: {},
      agentId: "main",
      store: { [sessionKey]: { sessionId: "late", updatedAt: 1 } },
    });
    vi.useFakeTimers();
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      ...bindSessionRowProjection({}, () => projection),
    } as unknown as GatewayRequestContext;
    const prepared = createDeferred();
    const prepare = projection.withPreparedExactRows.bind(projection);
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(async (queries, consume) => {
      await prepared.promise;
      return prepare(queries, consume);
    });
    const owner = createGatewaySidecarStopOwner();
    try {
      await attachInitialGatewayLifetimeSidecars({
        chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
        gatewayRequestContext: context,
        flushPendingSessionsChangedEvents,
        minimalTestGateway: true,
        logWarning: vi.fn(),
        publishSidecars: owner.publish,
      });
      await owner.stop();
      emitSessionsChanged(context, { reason: "patch", sessionKey });
      let sealed = false;
      const seal = owner.sealAndJoin().then(() => {
        sealed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const sealedBeforePublication = sealed;
      prepared.resolve();
      await seal;
      await flushPendingSessionsChangedEvents(context);
      expect(sealedBeforePublication).toBe(false);
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

  test("retains the shutdown budget for sidecars published later from startup", async () => {
    const owner = createGatewaySidecarStopOwner();
    const budget = { deadline: 10_000, warn: vi.fn() };
    await runWithProcessCleanupBudget(budget, () => owner.stop());
    const stopped = vi.fn(async () => {
      expect(getProcessCleanupBudget()).toBe(budget);
    });
    owner.publish({ stop: stopped });
    await owner.sealAndJoin();
    expect(stopped).toHaveBeenCalledOnce();
  });

  test("owns standalone GitHub publication recovery when worker placement is unavailable", async () => {
    vi.useFakeTimers();
    const reconcileGitHubPublications = vi.fn(async () => {});
    const owner = createGatewaySidecarStopOwner();

    await attachInitialGatewayLifetimeSidecars({
      chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
      gatewayRequestContext: {} as never,
      flushPendingSessionsChangedEvents: vi.fn(),
      minimalTestGateway: false,
      logWarning: vi.fn(),
      reconcileGitHubPublications,
      publishSidecars: owner.publish,
    });
    vi.runAllTicks();
    expect(reconcileGitHubPublications).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileGitHubPublications).toHaveBeenCalledTimes(2);
    await owner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcileGitHubPublications).toHaveBeenCalledTimes(2);
  });

  test("attaches and retires authorization lifecycles with the Gateway", async () => {
    const owner = createGatewaySidecarStopOwner();
    const context: Pick<
      GatewayRequestContext,
      "getRuntimeConfig" | "githubOAuthService" | "modelAccountConnectService"
    > = {
      getRuntimeConfig: vi.fn(() => ({})),
    };
    const warn = vi.fn();

    await attachInitialGatewayLifetimeSidecars({
      chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
      gatewayRequestContext: context as never,
      flushPendingSessionsChangedEvents: vi.fn(),
      minimalTestGateway: false,
      logWarning: warn,
      publishSidecars: owner.publish,
    });

    expect(oauth.create).toHaveBeenCalledWith({
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
    expect(() =>
      modelAccounts?.status({ owner: "profile-1", assertCurrent: () => {} }, "stale-flow"),
    ).toThrow("current authorized connection");
  });

  test.each([
    { minimalTestGateway: false, expectedHandoffRows: 0 },
    { minimalTestGateway: true, expectedHandoffRows: 1 },
  ])(
    "owns startup and scheduled handoff expiry when minimalTestGateway=$minimalTestGateway",
    async ({ minimalTestGateway, expectedHandoffRows }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: createStateDir() }, async () => {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const startupHandoff = "github-setup-55555555555555555555555555555555";
        writeStoredSecret(startupHandoff, "temporary-value");
        writeStoredSecret("RETAINED_SECRET", "retained-value");
        vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
        const owner = createGatewaySidecarStopOwner();
        const purge = secretStore.purgeExpiredSecretStoreEntries;
        const sweeps: Promise<number>[] = [];
        vi.spyOn(secretStore, "purgeExpiredSecretStoreEntries").mockImplementation((...args) => {
          const operation = purge(...args);
          sweeps.push(operation);
          return operation;
        });

        await attachInitialGatewayLifetimeSidecars({
          chatMetadataLifecycle: { attachContext: vi.fn(async () => {}) } as never,
          gatewayRequestContext: {} as never,
          flushPendingSessionsChangedEvents: vi.fn(),
          minimalTestGateway,
          logWarning: vi.fn(),
          publishSidecars: owner.publish,
        });
        await Promise.all(sweeps);
        expect(countStoredRows(startupHandoff)).toBe(expectedHandoffRows);

        const scheduledHandoff = "github-setup-77777777777777777777777777777777";
        writeStoredSecret(scheduledHandoff, "scheduled-value");
        vi.setSystemTime(new Date("2026-01-01T00:22:00.000Z"));
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.all(sweeps);

        expect(countStoredRows(scheduledHandoff)).toBe(expectedHandoffRows);
        expect(countStoredRows("RETAINED_SECRET")).toBe(1);
        await owner.stop();

        const stoppedHandoff = "github-setup-66666666666666666666666666666666";
        writeStoredSecret(stoppedHandoff, "post-stop-value");
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(countStoredRows(stoppedHandoff)).toBe(1);
      });
    },
  );
});
