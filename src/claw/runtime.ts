import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig } from "../config/config.js";
import { getGatewayBroadcastRuntime } from "../gateway/server-broadcast-runtime.js";
import { broadcastClawMissionSnapshot } from "./gateway-events.js";
import { clawMissionService } from "./service.js";

const log = createSubsystemLogger("claw/runtime");
const CLAW_RUNTIME_STATE_KEY = Symbol.for("openclaw.clawRuntimeState");

type ClawRuntimeState = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  wakeRequested: boolean;
  recovered: boolean;
};

function getRuntimeState(): ClawRuntimeState {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[CLAW_RUNTIME_STATE_KEY];
  if (existing && typeof existing === "object") {
    return existing as ClawRuntimeState;
  }
  const created: ClawRuntimeState = {
    started: false,
    timer: null,
    inFlight: false,
    wakeRequested: false,
    recovered: false,
  };
  globalRecord[CLAW_RUNTIME_STATE_KEY] = created;
  return created;
}

function resolveClawRuntimeConfig(): {
  enabled: boolean;
  loopMs: number;
} {
  const cfg = loadConfig();
  const loopMs =
    typeof cfg.claw?.loopMs === "number" && Number.isFinite(cfg.claw.loopMs) && cfg.claw.loopMs > 0
      ? Math.floor(cfg.claw.loopMs)
      : 5_000;
  return {
    enabled: cfg.claw?.enabled === true,
    loopMs,
  };
}

async function drainClawRuntimeQueue(): Promise<void> {
  const state = getRuntimeState();
  if (state.inFlight) {
    state.wakeRequested = true;
    return;
  }
  state.inFlight = true;
  try {
    do {
      state.wakeRequested = false;
      if (!state.recovered) {
        const recovered = await clawMissionService.recoverInterruptedMissions();
        if (recovered) {
          broadcastClawMissionSnapshot(getGatewayBroadcastRuntime(), { snapshot: recovered });
        }
        state.recovered = true;
      }
      const snapshot = await clawMissionService.runNextMissionCycle();
      if (snapshot) {
        broadcastClawMissionSnapshot(getGatewayBroadcastRuntime(), { snapshot });
      }
    } while (state.wakeRequested);
  } catch (error) {
    log.warn("Claw runtime iteration failed", { error });
  } finally {
    state.inFlight = false;
  }
}

export function wakeClawRuntime(): void {
  const { enabled } = resolveClawRuntimeConfig();
  if (!enabled) {
    return;
  }
  const state = getRuntimeState();
  state.wakeRequested = true;
  queueMicrotask(() => {
    void drainClawRuntimeQueue();
  });
}

export function ensureClawRuntimeStarted(): void {
  const { enabled, loopMs } = resolveClawRuntimeConfig();
  const state = getRuntimeState();
  if (!enabled) {
    return;
  }
  if (state.started) {
    return;
  }
  state.started = true;
  state.timer = setInterval(() => {
    void drainClawRuntimeQueue();
  }, loopMs);
  state.timer.unref?.();
  wakeClawRuntime();
}
