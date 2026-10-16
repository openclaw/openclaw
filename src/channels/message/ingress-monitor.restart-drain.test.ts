import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { channelIngressGatewayRestartEntrypoint } from "../../../test/fixtures/channel-ingress-gateway-restart-entrypoint.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { runDetachedWebhookWork } from "../../plugin-sdk/webhook-request-guards.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  getGatewaySuspendAdmissionPhase,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RestartDrainProof = {
  restart: string;
  committed: boolean;
  idleMs: number;
  finalActivity: boolean;
  exitCode: number;
};
type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
});

async function withQueue(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<void>,
): Promise<void> {
  const stateDir = tempDirs.make("openclaw-ingress-restart-lifecycle-");
  await run(createChannelIngressQueue({ channelId: "test", accountId: "a", stateDir }));
}

function createMonitor(
  queue: ChannelIngressQueue<StoredEvent>,
  deliver: (raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => Promise<void>,
  onActivityChange?: (active: boolean) => void,
  runPumpTask?: (work: () => Promise<void>) => Promise<void>,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver,
    pollIntervalMs: 60_000,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
      resolveNonRetryableFailure: () => null,
    },
    ...(onActivityChange ? { onActivityChange } : {}),
    ...(runPumpTask ? { runPumpTask } : {}),
  });
}

const event = (id: string, text = "deliver me", lane = "a"): RawEvent => ({ id, lane, text });
const stored = (raw: RawEvent): StoredEvent => ({ version: 1, rawEvent: JSON.stringify(raw) });
const adoptingDelivery = () =>
  vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
    await lifecycle.onAdopted();
  });

async function withRestartFence(
  run: (fixture: {
    monitor: ReturnType<typeof createMonitor>;
    deliver: ReturnType<typeof adoptingDelivery>;
    signal: ReturnType<typeof beginGatewayRestartSignalAdmission>;
    activity: boolean[];
  }) => Promise<void>,
) {
  await withQueue(async (queue) => {
    const deliver = adoptingDelivery();
    const activity: boolean[] = [];
    const monitor = createMonitor(queue, deliver, (active) => activity.push(active));
    let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;
      signal = beginGatewayRestartSignalAdmission();
      expect(signal).not.toBeNull();
      await run({ monitor, deliver, signal, activity });
    } finally {
      signal?.rollback();
      await monitor.stop();
    }
  });
}

function runRestartDrainFixture(stateDir: string): Promise<RestartDrainProof> {
  return new Promise((resolve, reject) => {
    const fixture = resolveRuntimeWorkerUrl(channelIngressGatewayRestartEntrypoint);
    const child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(fixture), stateDir], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: stateDir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      child.kill();
      reject(new Error("Gateway restart fixture stderr pipe was not created"));
      return;
    }
    let proof: RestartDrainProof | undefined;
    let failure: Error | undefined;
    let stderr = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      failure = new Error(message);
      child.kill();
    };
    const completionTimer = setTimeout(
      () => fail("Gateway restart fixture did not finish within 30 seconds"),
      30_000,
    );
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "ingress-restart-drain-committed") {
        idleTimer = setTimeout(
          () => fail("Ingress did not become idle within 3 seconds of restart drain"),
          3_000,
        );
        return;
      }
      if (message.type === "ingress-restart-idle") {
        clearTimeout(idleTimer);
        return;
      }
      if (message.type === "ingress-restart-proof" && "proof" in message) {
        proof = message.proof as RestartDrainProof;
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(completionTimer);
      clearTimeout(idleTimer);
      if (!failure && code === 0 && proof) {
        resolve(proof);
      } else {
        const reason = failure?.message ?? "Gateway restart fixture failed";
        reject(
          new Error(`${reason}; code=${String(code)} signal=${String(signal)} stderr=${stderr}`, {
            cause: failure,
          }),
        );
      }
    });
  });
}

it("reaches ingress idle after the Gateway commits restart drain", async () => {
  const stateDir = tempDirs.make("openclaw-ingress-gateway-restart-");
  const proof = await runRestartDrainFixture(stateDir);
  expect(proof).toMatchObject({
    restart: "emitted",
    committed: true,
    finalActivity: false,
    exitCode: 0,
  });
  expect(proof.idleMs).toBeLessThan(1_000);
}, 40_000);

it("rearms queued ingress after a restart signal rolls back without an idle observer", async () => {
  await withRestartFence(async ({ monitor, deliver, signal }) => {
    await monitor.admit(event("event-signal-rollback"));
    expect(deliver).not.toHaveBeenCalled();
    expect(signal?.rollback()).toBe(true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  });
});

it("holds queued ingress until host suspension reopens admission", async () => {
  await withQueue(async (queue) => {
    const deliver = adoptingDelivery();
    const monitor = createMonitor(queue, deliver);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      const raw = event("event-suspend-release");
      await queue.enqueue(raw.id, stored(raw), { laneKey: "lane:a" });
      monitor.start();

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(deliver).not.toHaveBeenCalled();

      expect(suspension?.rollback()).toBe(true);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      await monitor.waitForIdle();
    } finally {
      suspension?.rollback();
      await monitor.stop();
    }
  });
});

it("releases a claim without an attempt when suspension closes during the claim", async () => {
  await withQueue(async (queue) => {
    const raw = event("event-suspend-claim", "deliver after suspension");
    const payload = stored(raw);
    const claimReady = createDeferredCore();
    const returnClaim = createDeferredCore();
    const claimEvent = queue.claim.bind(queue);
    const claimSpy = vi.spyOn(queue, "claim").mockImplementationOnce(async (...args) => {
      const claim = await claimEvent(...args);
      // Keep the monitor awaiting the result after the real SQLite claim commits.
      claimReady.resolve();
      await returnClaim.promise;
      return claim;
    });
    const deliver = adoptingDelivery();
    const activity: boolean[] = [];
    const monitor = createMonitor(queue, deliver, (active) => activity.push(active));
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    try {
      await queue.enqueue(raw.id, payload, { laneKey: "lane:a" });
      monitor.start();
      await claimReady.promise;
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({ id: raw.id, payload, attempts: 0 }),
      ]);

      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
      returnClaim.resolve();
      await monitor.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      expect(await queue.listClaims()).toEqual([]);
      const pending = await queue.listPending();
      expect(pending).toEqual([
        expect.objectContaining({ id: raw.id, payload, laneKey: "lane:a", attempts: 0 }),
      ]);
      expect(pending[0]).not.toHaveProperty("lastAttemptAt");
      expect(pending[0]).not.toHaveProperty("lastError");
      expect(claimSpy).toHaveBeenCalledOnce();
      expect(activity.at(-1)).toBe(false);

      expect(suspension?.release()).toBe(true);
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledExactlyOnceWith(raw, expect.anything());
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.enqueue(raw.id, payload, { laneKey: "lane:a" })).toMatchObject({
        kind: "completed",
        duplicate: true,
      });
    } finally {
      returnClaim.resolve();
      await monitor.stop();
      suspension?.rollback();
      suspension?.release();
      claimSpy.mockRestore();
    }
  });
});

it("clears activity when a restart signal commits to one-way drain", async () => {
  await withRestartFence(async ({ monitor, activity }) => {
    monitor.requestDrain();
    expect(activity.at(-1)).toBe(true);

    markGatewayRestartDraining();
    await monitor.waitForIdle();
    expect(activity.at(-1)).toBe(false);
  });
});

it.each(["pause", "stop"] as const)(
  "releases idle waiters when %s ends a restart fence wait",
  async (action) => {
    await withRestartFence(async ({ monitor }) => {
      monitor.requestDrain();
      const idle = monitor.waitForIdle();

      await monitor[action]();
      await expect(idle).resolves.toBeUndefined();
    });
  },
);

it("propagates a rejected pump wrapper without spinning idle or stop waits", async () => {
  await withQueue(async (queue) => {
    const rejection = new Error("pump wrapper rejected");
    const monitor = createMonitor(
      queue,
      async () => {},
      undefined,
      async () => {
        throw rejection;
      },
    );
    monitor.start();

    await expect(monitor.waitForIdle()).rejects.toBe(rejection);
    await expect(monitor.stop()).rejects.toBe(rejection);
  });
});

it("retains adopted webhook delivery through restart while plugin cleanup owns its separate tail", async () => {
  await withQueue(async (queue) => {
    const adoptGate = createDeferredCore();
    const dispatchGate = createDeferredCore();
    const cleanupStarted = createDeferredCore();
    const cleanupGate = createDeferredCore();
    const cancelled = createDeferredCore();
    const instance = new PluginInstance("ingress-cleanup");
    const activity: boolean[] = [];
    const delivered: string[] = [];
    const pumpSignals: AbortSignal[] = [];
    const facts = {
      adopted: false,
      stoppingSettled: false,
      dispatchRetainedRoot: false,
      dispatchAdmissionClosed: false,
      cleanupSettled: false,
      disposalSettled: false,
    };
    const first = event("adopted", "already delivered");
    const interrupted = event("cancelled", "resume once", "b");
    const next = event("next", "next queued delivery", "b");
    const monitor = createMonitor(
      queue,
      async (raw, lifecycle) => {
        delivered.push(raw.id);
        if (raw.id === first.id) {
          await adoptGate.promise;
          await trackAsyncWork(() =>
            instance.run(() => {
              instance.lifecycle.onDispose(async () => {
                cleanupStarted.resolve();
                await cleanupGate.promise;
                await trackAsyncWork(() => {
                  facts.cleanupSettled = true;
                });
              });
            }),
          );
          await lifecycle.onAdopted();
          facts.adopted = true;
          await dispatchGate.promise;
          facts.dispatchRetainedRoot =
            getActiveGatewayRootWorkCount({ excludeCurrent: true }) <
            getActiveGatewayRootWorkCount();
          facts.dispatchAdmissionClosed = isGatewaySubordinateWorkAdmissionClosed();
          return;
        }
        await new Promise<void>((resolve) => {
          lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await lifecycle.onCancelled?.();
        cancelled.resolve();
      },
      (active) => activity.push(active),
      (work) =>
        runDetachedWebhookWork(async () => {
          const signal = getAsyncWorkSignal();
          expect(signal).toBeDefined();
          if (signal) {
            pumpSignals.push(signal);
          }
          await work();
        }),
    );
    const replacement = createMonitor(queue, async (raw, lifecycle) => {
      delivered.push(raw.id);
      await lifecycle.onAdopted();
    });
    let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      await monitor.admit(first);
      monitor.start();
      await monitor.waitForPumpIdle();
      await vi.waitFor(() => expect(pumpSignals[0]?.aborted).toBe(true));
      adoptGate.resolve();
      await vi.waitFor(() => expect(facts.adopted).toBe(true));
      await expect(queue.listClaims()).resolves.toEqual([]);
      await monitor.waitForPumpIdle();
      await vi.waitFor(() =>
        expect(getActiveGatewayRootWorkHolders()).toEqual(["webhook:detached"]),
      );
      expect(activity.at(-1)).toBe(true);

      await monitor.admit(interrupted);
      await monitor.admit(next);
      await monitor.waitForPumpIdle();
      expect(delivered).toEqual([first.id, interrupted.id]);
      signal = beginGatewayRestartSignalAdmission();
      expect(signal).not.toBeNull();
      markGatewayRestartDraining();
      const cleanup = instance.dispose().then((result) => {
        facts.disposalSettled = true;
        return result;
      });
      await cleanupStarted.promise;
      const stopping = monitor.stop().then(() => {
        facts.stoppingSettled = true;
      });
      await cancelled.promise;
      expect(facts.stoppingSettled).toBe(false);
      expect(activity.at(-1)).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);

      dispatchGate.resolve();
      await stopping;
      expect(facts).toMatchObject({ dispatchRetainedRoot: true, dispatchAdmissionClosed: true });
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(activity.at(-1)).toBe(false);
      expect(facts).toMatchObject({ cleanupSettled: false, disposalSettled: false });
      expect(instance.disposing).toBe(true);
      await expect(queue.listClaims()).resolves.toEqual([]);
      await expect(queue.listPending()).resolves.toEqual([
        expect.objectContaining({ id: interrupted.id, attempts: 0 }),
        expect.objectContaining({ id: next.id, attempts: 0 }),
      ]);

      cleanupGate.resolve();
      await expect(cleanup).resolves.toEqual({ errors: [] });
      expect(facts.cleanupSettled).toBe(true);
      resetGatewayWorkAdmission();
      replacement.start();
      await replacement.waitForIdle();
      await expect(replacement.admit(first)).resolves.toMatchObject({
        kind: "durable",
        queueResult: { kind: "completed", duplicate: true },
      });
      await replacement.waitForIdle();
      expect(delivered).toEqual([first.id, interrupted.id, interrupted.id, next.id]);
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toEqual([]);
    } finally {
      adoptGate.resolve();
      dispatchGate.resolve();
      cleanupGate.resolve();
      signal?.rollback();
      await monitor.stop();
      await replacement.stop();
      await instance.dispose();
    }
  });
});
