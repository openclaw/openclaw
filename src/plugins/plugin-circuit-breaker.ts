export const PLUGIN_CIRCUIT_BREAKER_STATUSES = ["closed", "open", "half-open"] as const;

export type PluginCircuitBreakerStatus = (typeof PLUGIN_CIRCUIT_BREAKER_STATUSES)[number];

export const PLUGIN_CRITICALITY_LEVELS = [
  "critical",
  "important",
  "optional",
  "experimental",
] as const;

export type PluginCriticality = (typeof PLUGIN_CRITICALITY_LEVELS)[number];

export type PluginCircuitBreakerFailureReason =
  | "health_check_failed"
  | "load_error"
  | "runtime_error"
  | "timeout"
  | "unknown";

export type PluginCircuitBreakerConfig = {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccessThreshold: number;
};

export type PluginCircuitBreakerState = {
  pluginId: string;
  criticality: PluginCriticality;
  status: PluginCircuitBreakerStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  updatedAtMs: number;
  openedAtMs?: number;
  nextProbeAtMs?: number;
  lastFailureAtMs?: number;
  lastFailureReason?: PluginCircuitBreakerFailureReason;
  lastSuccessAtMs?: number;
};

export type PluginCircuitBreakerDecision = {
  allowExecution: boolean;
  probe: boolean;
  state: PluginCircuitBreakerState;
  reason: "closed" | "cooldown_active" | "half_open_probe";
};

const IMPORTANT_PLUGIN_BREAKER_CONFIG: PluginCircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  halfOpenSuccessThreshold: 1,
};

const CONFIG_BY_CRITICALITY: Record<PluginCriticality, PluginCircuitBreakerConfig> = {
  critical: {
    failureThreshold: 5,
    cooldownMs: 30_000,
    halfOpenSuccessThreshold: 2,
  },
  important: IMPORTANT_PLUGIN_BREAKER_CONFIG,
  optional: {
    failureThreshold: 2,
    cooldownMs: 120_000,
    halfOpenSuccessThreshold: 1,
  },
  experimental: {
    failureThreshold: 1,
    cooldownMs: 300_000,
    halfOpenSuccessThreshold: 1,
  },
};

function isPluginCriticality(value: unknown): value is PluginCriticality {
  return (
    typeof value === "string" && PLUGIN_CRITICALITY_LEVELS.includes(value as PluginCriticality)
  );
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePluginId(pluginId: string): string {
  const trimmed = pluginId.trim();
  return trimmed || "unknown-plugin";
}

function normalizeFailureReason(reason: unknown): PluginCircuitBreakerFailureReason {
  if (
    reason === "health_check_failed" ||
    reason === "load_error" ||
    reason === "runtime_error" ||
    reason === "timeout"
  ) {
    return reason;
  }
  return "unknown";
}

export function normalizePluginCriticality(value: unknown): PluginCriticality {
  return isPluginCriticality(value) ? value : "important";
}

export function resolvePluginCircuitBreakerConfig(params?: {
  criticality?: unknown;
  overrides?: Partial<PluginCircuitBreakerConfig>;
}): PluginCircuitBreakerConfig {
  const base = CONFIG_BY_CRITICALITY[normalizePluginCriticality(params?.criticality)];
  return {
    failureThreshold: clampPositiveInteger(
      params?.overrides?.failureThreshold,
      base.failureThreshold,
    ),
    cooldownMs: clampPositiveInteger(params?.overrides?.cooldownMs, base.cooldownMs),
    halfOpenSuccessThreshold: clampPositiveInteger(
      params?.overrides?.halfOpenSuccessThreshold,
      base.halfOpenSuccessThreshold,
    ),
  };
}

export function createPluginCircuitBreakerState(params: {
  pluginId: string;
  criticality?: unknown;
  nowMs?: number;
}): PluginCircuitBreakerState {
  const nowMs = params.nowMs ?? Date.now();
  return {
    pluginId: normalizePluginId(params.pluginId),
    criticality: normalizePluginCriticality(params.criticality),
    status: "closed",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    updatedAtMs: nowMs,
  };
}

function openPluginCircuitBreaker(params: {
  state: PluginCircuitBreakerState;
  nowMs: number;
  config: PluginCircuitBreakerConfig;
  reason: PluginCircuitBreakerFailureReason;
  consecutiveFailures: number;
}): PluginCircuitBreakerState {
  return {
    ...params.state,
    status: "open",
    consecutiveFailures: params.consecutiveFailures,
    consecutiveSuccesses: 0,
    updatedAtMs: params.nowMs,
    openedAtMs: params.nowMs,
    nextProbeAtMs: params.nowMs + params.config.cooldownMs,
    lastFailureAtMs: params.nowMs,
    lastFailureReason: params.reason,
  };
}

function closePluginCircuitBreaker(
  state: PluginCircuitBreakerState,
  nowMs: number,
): PluginCircuitBreakerState {
  return {
    ...state,
    status: "closed",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    updatedAtMs: nowMs,
    openedAtMs: undefined,
    nextProbeAtMs: undefined,
    lastSuccessAtMs: nowMs,
  };
}

export function advancePluginCircuitBreakerState(params: {
  state: PluginCircuitBreakerState;
  nowMs?: number;
}): PluginCircuitBreakerState {
  const nowMs = params.nowMs ?? Date.now();
  if (params.state.status !== "open") {
    return params.state;
  }
  if ((params.state.nextProbeAtMs ?? Number.POSITIVE_INFINITY) > nowMs) {
    return params.state;
  }
  return {
    ...params.state,
    status: "half-open",
    consecutiveSuccesses: 0,
    updatedAtMs: nowMs,
  };
}

export function resolvePluginCircuitBreakerDecision(params: {
  state: PluginCircuitBreakerState;
  nowMs?: number;
}): PluginCircuitBreakerDecision {
  const nowMs = params.nowMs ?? Date.now();
  const state = advancePluginCircuitBreakerState({ state: params.state, nowMs });
  if (state.status === "open") {
    return {
      allowExecution: false,
      probe: false,
      state,
      reason: "cooldown_active",
    };
  }
  if (state.status === "half-open") {
    return {
      allowExecution: true,
      probe: true,
      state,
      reason: "half_open_probe",
    };
  }
  return {
    allowExecution: true,
    probe: false,
    state,
    reason: "closed",
  };
}

export function recordPluginCircuitBreakerFailure(params: {
  state: PluginCircuitBreakerState;
  reason?: unknown;
  nowMs?: number;
  config?: Partial<PluginCircuitBreakerConfig>;
}): PluginCircuitBreakerState {
  const nowMs = params.nowMs ?? Date.now();
  const state = advancePluginCircuitBreakerState({ state: params.state, nowMs });
  const config = resolvePluginCircuitBreakerConfig({
    criticality: state.criticality,
    overrides: params.config,
  });
  const reason = normalizeFailureReason(params.reason);
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (state.status === "half-open" || consecutiveFailures >= config.failureThreshold) {
    return openPluginCircuitBreaker({
      state,
      nowMs,
      config,
      reason,
      consecutiveFailures,
    });
  }
  return {
    ...state,
    consecutiveFailures,
    consecutiveSuccesses: 0,
    updatedAtMs: nowMs,
    lastFailureAtMs: nowMs,
    lastFailureReason: reason,
  };
}

export function recordPluginCircuitBreakerSuccess(params: {
  state: PluginCircuitBreakerState;
  nowMs?: number;
  config?: Partial<PluginCircuitBreakerConfig>;
}): PluginCircuitBreakerState {
  const nowMs = params.nowMs ?? Date.now();
  const state = advancePluginCircuitBreakerState({ state: params.state, nowMs });
  const config = resolvePluginCircuitBreakerConfig({
    criticality: state.criticality,
    overrides: params.config,
  });
  if (state.status === "half-open") {
    const consecutiveSuccesses = state.consecutiveSuccesses + 1;
    if (consecutiveSuccesses >= config.halfOpenSuccessThreshold) {
      return closePluginCircuitBreaker(
        {
          ...state,
          consecutiveSuccesses,
        },
        nowMs,
      );
    }
    return {
      ...state,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      updatedAtMs: nowMs,
      lastSuccessAtMs: nowMs,
    };
  }
  if (state.status === "open") {
    return state;
  }
  return closePluginCircuitBreaker(state, nowMs);
}
