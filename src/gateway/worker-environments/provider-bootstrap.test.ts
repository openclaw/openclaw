import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { writeSessionStore } from "../test-helpers.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { beforeSettlement, create, providerService } from "./provider-lifecycle.test-support.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import {
  BOOTSTRAP_RECEIPT,
  BUNDLE_ARTIFACT,
  SSH_ENDPOINT,
  type WorkerEnvironmentServiceError,
  createProvider,
  createService,
  setupWorkerEnvironmentServiceSuite,
  testState,
  waitForFast,
} from "./service.test-support.js";

const bootstrapFailure = {
  code: "bootstrap_failure",
} satisfies Partial<WorkerEnvironmentServiceError>;

describe("worker environment service", () => {
  setupWorkerEnvironmentServiceSuite();

  it.each([
    { bundle: "ordinary", advanceMs: 0 },
    { bundle: "large", advanceMs: 35 * 60_000 + 1 },
  ])("keeps a $bundle bundle bootstrapping until its receipt is durable", async ({ advanceMs }) => {
    // Leave the monotonic clock on the same native epoch as the SQLite workers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    if (advanceMs) {
      vi.mocked(testState.prepareInstallation).mockResolvedValue({
        ...BUNDLE_ARTIFACT,
        tarballBytes: 243_000_000,
      });
    }
    const pending = createDeferred();
    let bootstrapSignal: AbortSignal | undefined;
    testState.bootstrapWorker = vi.fn(async ({ signal }) => {
      bootstrapSignal = signal;
      await pending.promise;
      return BOOTSTRAP_RECEIPT;
    });
    const creation = create(providerService(), "request-bootstrap");
    await waitForFast(() => {
      expect(testState.store.list()[0]).toMatchObject({
        state: "bootstrapping",
        bootstrapReceipt: null,
      });
      expect(testState.bootstrapWorker).toHaveBeenCalledOnce();
    });
    try {
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(bootstrapSignal?.aborted).toBe(false);
    } finally {
      pending.resolve();
      await creation;
    }
    await expect(creation).resolves.toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
    expect(testState.store.list()[0]).toMatchObject({ state: "ready" });
  });

  it("records installation preparation failure before allocating a lease", async () => {
    vi.mocked(testState.prepareInstallation).mockRejectedValue(
      new Error("npm install requires a released gateway package"),
    );
    const provision = vi.fn(createProvider().provision);
    const workerService = providerService({ provision });

    await expect(create(workerService, "request-preparation-failure")).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("npm install requires a released gateway package"),
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(provision).not.toHaveBeenCalled();
    expect(testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "npm install requires a released gateway package",
    });
    expect(workerService.list()[0]).toMatchObject({
      state: "failed",
      error: "npm install requires a released gateway package",
    });
  });

  it("keeps a remotely bootstrapped lease retryable when receipt persistence fails", async () => {
    const durableStore = testState.store;
    let persistenceFails = true;
    testState.store = {
      ...testState.store,
      transition(input) {
        if (persistenceFails && input.from === "bootstrapping" && input.to === "ready") {
          persistenceFails = false;
          throw new Error("receipt database write failed");
        }
        return durableStore.transition(input);
      },
    };
    const destroy = vi.fn(async () => {});
    const workerService = providerService({ destroy });

    await expect(create(workerService, "request-receipt-write-failure")).rejects.toThrow(
      "receipt database write failed",
    );
    expect(testState.store.list()[0]).toMatchObject({ state: "bootstrapping", leaseId: "lease-1" });
    expect(destroy).not.toHaveBeenCalled();

    await workerService.reconcileOnce();
    expect(testState.store.list()[0]).toMatchObject({
      state: "ready",
      bootstrapReceipt: BOOTSTRAP_RECEIPT,
    });
    expect(testState.bootstrapWorker).toHaveBeenCalledTimes(2);
  });

  it("projects bounded bootstrap detail through sessions.describe after failed dispatch", async () => {
    // Assembled at runtime so review-bundle secret scanners do not flag a key-shaped literal.
    const secret = String.fromCharCode(115, 107) + "-proj-placement-abcdefghijklmnopqrstuvwxyz";
    vi.mocked(testState.bootstrapWorker).mockRejectedValue(
      new Error(`remote bootstrap rejected ${secret} ${"failure ".repeat(200)}`),
    );
    const destroy = vi.fn(async () => {});
    const workerService = providerService({ destroy });
    const placements = createWorkerSessionPlacementStore({
      database: testState.stateDb,
      now: () => testState.nowMs,
    });
    const dispatch = createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments: workerService,
    });

    const dispatchFailure = dispatch.dispatch({
      sessionId: "session-bootstrap-failure",
      sessionKey: "agent:main:session-bootstrap-failure",
      agentId: "main",
      profileId: "development",
      executionMode: "remote-exec",
    });
    await expect(dispatchFailure).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("Worker bootstrap failed: remote bootstrap rejected"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(dispatchFailure).rejects.not.toThrow(secret);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      lastError: expect.stringContaining("remote bootstrap rejected"),
    });
    expect(testState.store.list()[0]?.lastError).not.toContain(secret);

    const persisted = expectDefined(
      placements.get("session-bootstrap-failure"),
      "failed worker placement",
    );
    const sessionStorePath = path.join(testState.root, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: persisted.sessionId, updatedAt: testState.nowMs } },
      storePath: sessionStorePath,
    });
    const config = { session: { store: sessionStorePath } };
    const described = await directSessionReq<{ session: GatewaySessionRow | null }>(
      "sessions.describe",
      { key: "main" },
      {
        context: {
          getRuntimeConfig: () => config,
          workerSessionPlacementService: placements,
        },
      },
    );
    const describedPlacement = described.payload?.session?.placement;
    expect(described).toMatchObject({ ok: true });
    expect(describedPlacement).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("remote bootstrap rejected"),
    });
    if (describedPlacement?.state !== "failed") {
      throw new Error("sessions.describe did not project the failed worker placement");
    }
    expect(describedPlacement.recoveryError).not.toContain(secret);
    expect(describedPlacement.recoveryError.length).toBeLessThanOrEqual(1_024);
  });

  it("keeps an indeterminate bootstrap teardown retryable", async () => {
    vi.mocked(testState.bootstrapWorker).mockRejectedValue(new Error("remote bootstrap failed"));
    const destroy = vi
      .fn(async () => {})
      .mockRejectedValue(new Error("provider teardown timed out"));
    const workerService = providerService({ destroy });

    await expect(create(workerService, "request-bootstrap-cleanup")).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: "Worker bootstrap failed; teardown is pending: remote bootstrap failed",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(testState.store.list()[0]).toMatchObject({
      state: "destroying",
      leaseId: "lease-1",
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });

    destroy.mockResolvedValue(undefined);
    await workerService.reconcileOnce();
    expect(testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: expect.stringContaining("remote bootstrap failed"),
    });
  });

  it("bounds worker identity resolution as a provider operation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events: string[] = [];
    const identityStarted = createDeferred();
    const destroying = createDeferred();
    const { promise: identityPending, resolve: finishIdentity } = createDeferred();
    testState.bootstrapWorker = vi.fn(async ({ resolveIdentity, signal }) => {
      signal.addEventListener("abort", () => void events.push("abort"), { once: true });
      await resolveIdentity(SSH_ENDPOINT.keyRef, { assertCurrent: () => signal.throwIfAborted() });
      return BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const workerService = createService(createProvider({ destroy }), {
      providerCallTimeoutMs: 5,
      resolveSshIdentity: async () => {
        events.push("identity:start");
        identityStarted.resolve();
        await identityPending;
        events.push("identity:end");
        return { kind: "path", path: "/keys/worker" };
      },
    });
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        "all" in change &&
        change.scope === "worker-environments" &&
        testState.store.list()[0]?.state === "destroying"
      ) {
        destroying.resolve();
      }
    });
    const creationResult = create(workerService, "request-identity-timeout").catch(
      (error: unknown) => error,
    );
    try {
      await beforeSettlement(identityStarted.promise, creationResult, "Identity resolution");
      await vi.advanceTimersByTimeAsync(5);
      await beforeSettlement(destroying.promise, creationResult, "Bootstrap teardown");
      expect(events).toEqual(["identity:start", "abort"]);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      finishIdentity();
      await creationResult;
    }

    expect(await creationResult).toMatchObject(bootstrapFailure);
    expect(destroy).toHaveBeenCalledOnce();
    expect(events).toEqual(["identity:start", "abort", "identity:end", "destroy"]);
    expect(testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("aborts a timed-out SSH bootstrap before tearing down its lease", async () => {
    const events: string[] = [];
    testState.bootstrapWorker = vi.fn(async ({ signal }) => {
      await waitForAbortSignal(signal);
      events.push("abort");
      throw new Error("SSH bootstrap aborted");
    });
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const workerService = createService(createProvider({ destroy }), {
      bootstrapCallTimeoutMs: 10,
    });

    await expect(create(workerService, "request-bootstrap-timeout")).rejects.toMatchObject(
      bootstrapFailure,
    );

    expect(events).toEqual(["abort", "destroy"]);
    expect(testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });
});
