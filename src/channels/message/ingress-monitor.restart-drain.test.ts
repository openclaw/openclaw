import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { channelIngressGatewayRestartEntrypoint } from "../../../test/fixtures/channel-ingress-gateway-restart-entrypoint.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import {
  beginGatewayRestartSignalAdmission,
  getGatewaySuspendAdmissionPhase,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
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
    const startupTimer = setTimeout(() => {
      failure = new Error("Gateway restart fixture did not commit drain within 30 seconds");
      child.kill();
    }, 30_000);
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "ingress-restart-drain-committed") {
        clearTimeout(startupTimer);
        idleTimer = setTimeout(() => {
          failure = new Error("Ingress did not become idle within 3 seconds of restart drain");
          child.kill();
        }, 3_000);
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
      clearTimeout(startupTimer);
      clearTimeout(idleTimer);
      if (failure) {
        reject(
          new Error(
            `${failure.message}; code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
            { cause: failure },
          ),
        );
        return;
      }
      if (code !== 0 || !proof) {
        reject(
          new Error(
            `Gateway restart fixture failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          ),
        );
        return;
      }
      resolve(proof);
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
  await withQueue(async (queue) => {
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(queue, deliver);
    let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      monitor.start();
      await monitor.waitForIdle();
      signal = beginGatewayRestartSignalAdmission();
      expect(signal).not.toBeNull();
      await monitor.admit({ id: "event-signal-rollback", lane: "a", text: "deliver me" });
      expect(deliver).not.toHaveBeenCalled();

      expect(signal?.rollback()).toBe(true);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    } finally {
      signal?.rollback();
      await monitor.stop();
    }
  });
});

it("holds queued ingress until host suspension reopens admission", async () => {
  await withQueue(async (queue) => {
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(queue, deliver);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      await queue.enqueue(
        "event-suspend-release",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "event-suspend-release", lane: "a", text: "deliver me" }),
        },
        { laneKey: "lane:a" },
      );
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
    const raw: RawEvent = {
      id: "event-suspend-claim",
      lane: "a",
      text: "deliver after suspension",
    };
    const payload: StoredEvent = { version: 1, rawEvent: JSON.stringify(raw) };
    const claimReady = createDeferredCore();
    const returnClaim = createDeferredCore();
    const claimNext = queue.claimNext.bind(queue);
    const claimNextSpy = vi.spyOn(queue, "claimNext").mockImplementationOnce(async (...args) => {
      const claim = await claimNext(...args);
      // Keep the monitor awaiting the result after the real SQLite claim commits.
      claimReady.resolve();
      await returnClaim.promise;
      return claim;
    });
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await lifecycle.onAdopted();
    });
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
      expect(claimNextSpy).toHaveBeenCalledOnce();
      expect(activity.at(-1)).toBe(false);

      expect(suspension?.release()).toBe(true);
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0]).toEqual(raw);
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
      claimNextSpy.mockRestore();
    }
  });
});

it("clears activity when a restart signal commits to one-way drain", async () => {
  await withQueue(async (queue) => {
    const activity: boolean[] = [];
    const monitor = createMonitor(
      queue,
      async () => {},
      (active) => activity.push(active),
    );
    try {
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;

      expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
      monitor.requestDrain();
      expect(activity.at(-1)).toBe(true);

      markGatewayRestartDraining();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
    } finally {
      await monitor.stop();
    }
  });
});

it.each(["pause", "stop"] as const)(
  "releases idle waiters when %s ends a restart fence wait",
  async (action) => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, async () => {});
      let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
      try {
        monitor.start();
        await monitor.waitForIdle();
        signal = beginGatewayRestartSignalAdmission();
        expect(signal).not.toBeNull();
        monitor.requestDrain();
        const idle = monitor.waitForIdle();

        await monitor[action]();
        await expect(idle).resolves.toBeUndefined();
      } finally {
        signal?.rollback();
        await monitor.stop();
      }
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
