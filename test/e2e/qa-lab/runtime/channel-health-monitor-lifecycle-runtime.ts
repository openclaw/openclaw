import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChannelAccountSnapshot,
  ChannelId,
} from "../../../../src/channels/plugins/types.public.js";
import { startChannelHealthMonitor } from "../../../../src/gateway/channel-health-monitor.js";
import {
  evaluateChannelHealth,
  type ChannelHealthPolicy,
} from "../../../../src/gateway/channel-health-policy.js";
import type {
  ChannelAccountStartOutcome,
  ChannelRuntimeSnapshot,
} from "../../../../src/gateway/server-channel-runtime.types.js";
import type { ChannelManager } from "../../../../src/gateway/server-channels.js";
import { GatewayScheduler } from "../../../../src/infra/gateway-scheduler.js";
import { resetLogger, setLoggerOverride } from "../../../../src/logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../../../src/logging/test-helpers/diagnostic-log-capture.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { createGatewaySchedulerClock } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/channel-health-monitor-lifecycle-runtime.ts";
const SCENARIO_PATH = "qa/scenarios/observability/channel-health-monitor-lifecycle.yaml";

type MonitorProof = {
  graceRespected: boolean;
  operationOrder: string[];
  restartLog: string;
  policyReasons: string[];
  singleFlight: boolean;
  settledRearmed: boolean;
  cooldownBounded: boolean;
  exactCadenceThrottled: boolean;
  failureRecovered: boolean;
  shutdownStoppedChecks: boolean;
};

function snapshot(account: ChannelAccountSnapshot): ChannelRuntimeSnapshot {
  return {
    channels: { "qa-channel": account },
    channelAccounts: { "qa-channel": { monitored: account } },
  };
}

function policyReason(value: Record<string, unknown>, policy: ChannelHealthPolicy): string {
  return evaluateChannelHealth(value, policy).reason;
}

async function captureMonitorLogs(run: () => Promise<Omit<MonitorProof, "restartLog">>) {
  // openclaw-temp-dir: standalone producer removes this log root in its finally block
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-health-monitor-proof-"));
  const capture = createDiagnosticLogRecordCapture();
  setLoggerOverride({
    level: "info",
    consoleLevel: "silent",
    file: path.join(logDir, "monitor.log"),
  });
  try {
    const proof = await run();
    await capture.flush();
    const messages = capture.records.map((record) => record.message);
    const restartLog =
      messages.find((message) =>
        message.includes(
          "[qa-channel:monitored] health-monitor: restarting (reason: disconnected)",
        ),
      ) ?? "";
    return {
      ...proof,
      restartLog,
    };
  } finally {
    capture.cleanup();
    setLoggerOverride(null);
    resetLogger();
    await fs.rm(logDir, { recursive: true, force: true });
  }
}

export async function runChannelHealthMonitorLifecycleProof(): Promise<MonitorProof> {
  return await captureMonitorLogs(async () => {
    const now = Date.now();
    const clock = createGatewaySchedulerClock(now);
    const stopGate = createDeferredCore();
    let keepDisconnected = false;
    const policy = {
      channelId: "qa-channel" as ChannelId,
      now,
      channelConnectGraceMs: 100,
      staleEventThresholdMs: 100,
    };
    const policyReasons = [
      policyReason(
        { running: true, connected: false, lastStartAt: now - 20, enabled: true, configured: true },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: true,
          lastStartAt: now - 1_000,
          lastTransportActivityAt: now - 1_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: false,
          busy: true,
          activeRuns: 1,
          lastRunActivityAt: now - 1_000,
          activeRunStartedAt: now - 1_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: false,
          busy: true,
          activeRuns: 1,
          lastRunActivityAt: now - 26 * 60_000,
          activeRunStartedAt: now - 26 * 60_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
    ];

    const operations: string[] = [];
    let snapshotCalls = 0;
    let firstSnapshotAt: number | undefined;
    let activeSnapshots = 0;
    let maxActiveSnapshots = 0;
    let failNextSnapshot = true;
    let account: ChannelAccountSnapshot = {
      accountId: "monitored",
      running: true,
      connected: false,
      enabled: true,
      configured: true,
      lastStartAt: now - 300_000,
    };
    const manager: Parameters<typeof startChannelHealthMonitor>[0]["channelManager"] &
      Pick<ChannelManager, "stopChannel"> = {
      getRuntimeSnapshot() {
        snapshotCalls += 1;
        firstSnapshotAt ??= clock.clock.now();
        activeSnapshots += 1;
        maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
        try {
          if (failNextSnapshot) {
            failNextSnapshot = false;
            throw new Error("controlled snapshot failure");
          }
          operations.push("snapshot");
          return snapshot(account);
        } finally {
          activeSnapshots -= 1;
        }
      },
      async stopChannel(channelId, accountId, options) {
        operations.push(`stop:${channelId}:${accountId}:${String(options?.manual)}`);
        await stopGate.promise;
      },
      resetRestartAttempts(channelId: ChannelId, accountId: string) {
        operations.push(`reset:${channelId}:${accountId}`);
      },
      async startChannel(channelId, accountId) {
        operations.push(`start:${channelId}:${accountId}`);
        account = {
          ...account,
          running: true,
          connected: !keepDisconnected,
          lastStartAt: clock.clock.now(),
          lastTransportActivityAt: clock.clock.now(),
        };
        return new Map<string, ChannelAccountStartOutcome>([
          [account.accountId, { status: "handed-off" }],
        ]);
      },
      captureAccountRestart:
        (channelId, accountId, reason, options) => async (shouldContinue: () => boolean) => {
          if (!shouldContinue()) {
            return false;
          }
          await manager.stopChannel(channelId, accountId, { manual: false });
          if (!shouldContinue()) {
            return false;
          }
          if (options?.resetRestartAttempts) {
            manager.resetRestartAttempts(channelId, accountId);
          }
          await manager.startChannel(channelId, accountId, { reason, preserveManualStop: true });
          return true;
        },
      getAutostartSuppression: () => null,
      recoverAutostartSuppression: () => undefined,
      isAmbientAutostartSuppressed: () => false,
      isHealthMonitorEnabled: () => true,
      isAccountListed: () => true,
      isManuallyStopped: () => false,
      isAutoRestartScheduled: () => false,
    };

    const monitorStartupGraceMs = 60_000;
    const checkIntervalMs = 5 * 60_000;
    const monitorStartedAt = clock.clock.now();
    const scheduler = new GatewayScheduler({ clock: clock.clock });
    const monitor = startChannelHealthMonitor({ scheduler, channelManager: manager });

    try {
      await clock.advanceBy(monitorStartupGraceMs - 1);
      const noEarlySnapshot = snapshotCalls === 0;
      await clock.advanceBy(1);
      const graceRespected =
        noEarlySnapshot &&
        firstSnapshotAt !== undefined &&
        firstSnapshotAt - monitorStartedAt >= monitorStartupGraceMs;
      const restart = clock.advanceBy(checkIntervalMs);
      const callsDuringRestart = snapshotCalls;
      await clock.advanceBy(checkIntervalMs);
      const singleFlight = maxActiveSnapshots === 1 && snapshotCalls === callsDuringRestart;
      stopGate.resolve();
      await restart;

      keepDisconnected = true;
      account = {
        ...account,
        connected: false,
        lastStartAt: clock.clock.now() - 300_000,
      };
      const callsAfterRecovery = snapshotCalls;
      await clock.advanceBy(checkIntervalMs);
      const settledRearmed = snapshotCalls > callsAfterRecovery;
      const failureRecovered = operations.filter((entry) => entry === "snapshot").length >= 2;
      const startCount = operations.filter((entry) => entry.startsWith("start:")).length;
      const cooldownBounded = startCount === 1;
      for (let check = 0; check < 9; check += 1) {
        await clock.advanceBy(checkIntervalMs);
      }
      // These exact virtual wakes yield four restarts; ordinary timer jitter
      // can allow the next retry just after the ten-minute cooldown.
      const exactCadenceThrottled =
        operations.filter((entry) => entry.startsWith("start:")).length === 4;

      monitor.shutdown();
      await monitor.waitForIdle();
      const callsAtShutdown = snapshotCalls;
      await clock.advanceBy(checkIntervalMs);

      return {
        graceRespected,
        operationOrder: operations.filter((entry) => entry !== "snapshot"),
        policyReasons,
        singleFlight,
        settledRearmed,
        cooldownBounded,
        exactCadenceThrottled,
        failureRecovered,
        shutdownStoppedChecks: snapshotCalls === callsAtShutdown,
      };
    } finally {
      stopGate.resolve();
      monitor.shutdown();
      await scheduler.stop();
    }
  });
}

function parseArtifactBase(argv: readonly string[]) {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

export async function main(argv = process.argv.slice(2)) {
  const artifactBase = parseArtifactBase(argv);
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const writer = createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: "channel-health-monitor-lifecycle.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "channel-health-monitor-lifecycle",
      title: "Channel health monitor lifecycle",
      sourcePath: SCENARIO_PATH,
      docsRefs: ["docs/gateway/health.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/channel-health-monitor.ts"],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runChannelHealthMonitorLifecycleProof();
    const expectedOrder = [
      "stop:qa-channel:monitored:false",
      "reset:qa-channel:monitored",
      "start:qa-channel:monitored",
    ];
    const failures = [
      !proof.graceRespected && "startup grace was not respected",
      proof.operationOrder.slice(0, 3).join("|") !== expectedOrder.join("|") &&
        `restart order was ${proof.operationOrder.join(",")}`,
      !proof.restartLog && "restart reason log was not captured",
      proof.policyReasons.join("|") !==
        ["startup-connect-grace", "stale-socket", "busy", "stuck"].join("|") &&
        `policy reasons were ${proof.policyReasons.join(",")}`,
      !proof.singleFlight && "checks overlapped",
      !proof.settledRearmed && "settled check did not rearm",
      !proof.cooldownBounded && "cooldown allowed another restart",
      !proof.exactCadenceThrottled && "exact-cadence cooldown was not respected",
      !proof.failureRecovered && "loop did not recover from snapshot failure",
      !proof.shutdownStoppedChecks && "checks continued after shutdown",
    ].filter((value): value is string => Boolean(value));
    writer.appendLog(`${JSON.stringify(proof, null, 2)}\n`);
    await writer.write({
      status: failures.length === 0 ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      details:
        failures.length === 0
          ? "production monitor lifecycle boundaries passed"
          : failures.join("; "),
    });
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  } catch (error) {
    writer.appendLog(`${error instanceof Error ? error.stack : String(error)}\n`);
    await writer.write({
      status: "fail",
      durationMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
