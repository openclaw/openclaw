import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deliverQueuedSessionDelivery } from "../gateway/server-restart-sentinel.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import * as heartbeatWake from "./heartbeat-wake.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it("keeps recovered work on the ordinary budget and periodic heartbeats on 600 seconds", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: tmpDir, heartbeat: { every: "30m", target: "none" } },
      },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
    await seedSessionStore(storePath, sessionKey, { sessionId: "requester" });
    // Drive the emitted wake explicitly; recovery delivery, queueing, and classification stay real.
    const wake = vi.spyOn(heartbeatWake, "requestHeartbeat").mockImplementation(() => {});
    const deps = { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => 0 };
    for (const kind of ["systemEvent", "agentTurn"] as const) {
      replySpy.mockReset().mockResolvedValue({ text: "HEARTBEAT_OK" });
      wake.mockClear();
      resetSystemEventsForTest();
      const message = `Continue interrupted ${kind} work.`;
      const shared = { id: `restart-${kind}`, sessionKey, enqueuedAt: 1, retryCount: 0 };
      await deliverQueuedSessionDelivery({
        deps: {},
        queueContext: captureOpenClawStateWorkerContext(),
        entry:
          kind === "systemEvent"
            ? { ...shared, kind, text: message }
            : { ...shared, kind, message, messageId: shared.id },
      });
      expect(wake).toHaveBeenCalledOnce();
      await runHeartbeatOnce({ ...wake.mock.calls[0]![0], cfg, deps });
      expect(replySpy).toHaveBeenCalledOnce();
      const options = replySpy.mock.calls[0]![1];
      expect(getReplySystemEventContext(options)?.events?.map((event) => event.text)).toContain(
        message,
      );
      expect.soft(options?.timeoutOverrideSeconds, kind).toBeUndefined();
      expect
        .soft(
          resolveAgentTimeoutMs({ cfg, overrideSeconds: options?.timeoutOverrideSeconds }),
          kind,
        )
        .toBe(172_800_000);
    }
    replySpy.mockClear();
    resetSystemEventsForTest();
    await runHeartbeatOnce({
      cfg,
      agentId: "main",
      sessionKey,
      source: "interval",
      intent: "scheduled",
      deps,
    });
    expect(replySpy).toHaveBeenCalledOnce();
    expect(replySpy.mock.calls[0]![1]?.timeoutOverrideSeconds).toBe(600);
  });
});
