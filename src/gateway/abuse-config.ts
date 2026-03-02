import type { GatewayAbuseConfig, GatewayAbuseMode, OpenClawConfig } from "../config/config.js";

export type ResolvedGatewayAbuseQuotaConfig = {
  mode: GatewayAbuseMode;
  burstLimit: number;
  burstWindowMs: number;
  sustainedLimit: number;
  sustainedWindowMs: number;
};

export type ResolvedGatewayAbuseAnomalyConfig = {
  mode: GatewayAbuseMode;
  warningThreshold: number;
  throttleThreshold: number;
  blockThreshold: number;
  blockDurationMs: number;
};

export type ResolvedGatewayAbuseCorrelationConfig = {
  mode: GatewayAbuseMode;
  windowMs: number;
  decayHalfLifeMs: number;
  warningScore: number;
  criticalScore: number;
};

export type ResolvedGatewayAbuseIncidentConfig = {
  mode: GatewayAbuseMode;
  autoContainment: {
    enabled: boolean;
    minSeverity: "warn" | "critical";
    ttlMs: number;
  };
  retentionDays: number;
};

export type ResolvedGatewayAbuseAuditLedgerConfig = {
  mode: GatewayAbuseMode;
  retentionDays: number;
  maxRecords: number;
  redactPayloads: boolean;
};

export type ResolvedGatewayAbuseConfig = {
  quota: ResolvedGatewayAbuseQuotaConfig;
  anomaly: ResolvedGatewayAbuseAnomalyConfig;
  correlation: ResolvedGatewayAbuseCorrelationConfig;
  incident: ResolvedGatewayAbuseIncidentConfig;
  auditLedger: ResolvedGatewayAbuseAuditLedgerConfig;
};

const DEFAULT_MODE: GatewayAbuseMode = "off";

const DEFAULT_GATEWAY_ABUSE_CONFIG: ResolvedGatewayAbuseConfig = {
  quota: {
    mode: DEFAULT_MODE,
    burstLimit: 20,
    burstWindowMs: 10_000,
    sustainedLimit: 120,
    sustainedWindowMs: 60_000,
  },
  anomaly: {
    mode: DEFAULT_MODE,
    warningThreshold: 30,
    throttleThreshold: 60,
    blockThreshold: 90,
    blockDurationMs: 300_000,
  },
  correlation: {
    mode: DEFAULT_MODE,
    windowMs: 900_000,
    decayHalfLifeMs: 300_000,
    warningScore: 50,
    criticalScore: 80,
  },
  incident: {
    mode: DEFAULT_MODE,
    autoContainment: {
      enabled: false,
      minSeverity: "critical",
      ttlMs: 600_000,
    },
    retentionDays: 14,
  },
  auditLedger: {
    mode: DEFAULT_MODE,
    retentionDays: 14,
    maxRecords: 100_000,
    redactPayloads: true,
  },
};

function resolveMode(mode?: GatewayAbuseMode): GatewayAbuseMode {
  return mode === "off" || mode === "observe" || mode === "enforce" ? mode : DEFAULT_MODE;
}

function resolvePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function validateResolvedGatewayAbuseConfig(config: ResolvedGatewayAbuseConfig): void {
  if (config.quota.sustainedWindowMs < config.quota.burstWindowMs) {
    throw new Error(
      "gateway.abuse.quota.sustainedWindowMs must be >= burstWindowMs after defaults are applied.",
    );
  }
  if (config.anomaly.warningThreshold >= config.anomaly.throttleThreshold) {
    throw new Error(
      "gateway.abuse.anomaly.warningThreshold must be < throttleThreshold after defaults are applied.",
    );
  }
  if (config.anomaly.throttleThreshold >= config.anomaly.blockThreshold) {
    throw new Error(
      "gateway.abuse.anomaly.throttleThreshold must be < blockThreshold after defaults are applied.",
    );
  }
  if (config.correlation.warningScore >= config.correlation.criticalScore) {
    throw new Error(
      "gateway.abuse.correlation.warningScore must be < criticalScore after defaults are applied.",
    );
  }
}

export function resolveGatewayAbuseConfig(
  cfg: OpenClawConfig,
  overrides?: GatewayAbuseConfig,
): ResolvedGatewayAbuseConfig {
  const base = cfg.gateway?.abuse;

  const quota = {
    ...base?.quota,
    ...overrides?.quota,
  };
  const anomaly = {
    ...base?.anomaly,
    ...overrides?.anomaly,
  };
  const correlation = {
    ...base?.correlation,
    ...overrides?.correlation,
  };
  const incident = {
    ...base?.incident,
    ...overrides?.incident,
    autoContainment: {
      ...base?.incident?.autoContainment,
      ...overrides?.incident?.autoContainment,
    },
  };
  const auditLedger = {
    ...base?.auditLedger,
    ...overrides?.auditLedger,
  };

  const resolved: ResolvedGatewayAbuseConfig = {
    quota: {
      mode: resolveMode(quota.mode),
      burstLimit: resolvePositiveInt(
        quota.burstLimit,
        DEFAULT_GATEWAY_ABUSE_CONFIG.quota.burstLimit,
      ),
      burstWindowMs: resolvePositiveInt(
        quota.burstWindowMs,
        DEFAULT_GATEWAY_ABUSE_CONFIG.quota.burstWindowMs,
      ),
      sustainedLimit: resolvePositiveInt(
        quota.sustainedLimit,
        DEFAULT_GATEWAY_ABUSE_CONFIG.quota.sustainedLimit,
      ),
      sustainedWindowMs: resolvePositiveInt(
        quota.sustainedWindowMs,
        DEFAULT_GATEWAY_ABUSE_CONFIG.quota.sustainedWindowMs,
      ),
    },
    anomaly: {
      mode: resolveMode(anomaly.mode),
      warningThreshold: resolvePositiveInt(
        anomaly.warningThreshold,
        DEFAULT_GATEWAY_ABUSE_CONFIG.anomaly.warningThreshold,
      ),
      throttleThreshold: resolvePositiveInt(
        anomaly.throttleThreshold,
        DEFAULT_GATEWAY_ABUSE_CONFIG.anomaly.throttleThreshold,
      ),
      blockThreshold: resolvePositiveInt(
        anomaly.blockThreshold,
        DEFAULT_GATEWAY_ABUSE_CONFIG.anomaly.blockThreshold,
      ),
      blockDurationMs: resolvePositiveInt(
        anomaly.blockDurationMs,
        DEFAULT_GATEWAY_ABUSE_CONFIG.anomaly.blockDurationMs,
      ),
    },
    correlation: {
      mode: resolveMode(correlation.mode),
      windowMs: resolvePositiveInt(
        correlation.windowMs,
        DEFAULT_GATEWAY_ABUSE_CONFIG.correlation.windowMs,
      ),
      decayHalfLifeMs: resolvePositiveInt(
        correlation.decayHalfLifeMs,
        DEFAULT_GATEWAY_ABUSE_CONFIG.correlation.decayHalfLifeMs,
      ),
      warningScore: resolvePositiveInt(
        correlation.warningScore,
        DEFAULT_GATEWAY_ABUSE_CONFIG.correlation.warningScore,
      ),
      criticalScore: resolvePositiveInt(
        correlation.criticalScore,
        DEFAULT_GATEWAY_ABUSE_CONFIG.correlation.criticalScore,
      ),
    },
    incident: {
      mode: resolveMode(incident.mode),
      autoContainment: {
        enabled:
          typeof incident.autoContainment?.enabled === "boolean"
            ? incident.autoContainment.enabled
            : DEFAULT_GATEWAY_ABUSE_CONFIG.incident.autoContainment.enabled,
        minSeverity:
          incident.autoContainment?.minSeverity === "warn" ||
          incident.autoContainment?.minSeverity === "critical"
            ? incident.autoContainment.minSeverity
            : DEFAULT_GATEWAY_ABUSE_CONFIG.incident.autoContainment.minSeverity,
        ttlMs: resolvePositiveInt(
          incident.autoContainment?.ttlMs,
          DEFAULT_GATEWAY_ABUSE_CONFIG.incident.autoContainment.ttlMs,
        ),
      },
      retentionDays: resolvePositiveInt(
        incident.retentionDays,
        DEFAULT_GATEWAY_ABUSE_CONFIG.incident.retentionDays,
      ),
    },
    auditLedger: {
      mode: resolveMode(auditLedger.mode),
      retentionDays: resolvePositiveInt(
        auditLedger.retentionDays,
        DEFAULT_GATEWAY_ABUSE_CONFIG.auditLedger.retentionDays,
      ),
      maxRecords: resolvePositiveInt(
        auditLedger.maxRecords,
        DEFAULT_GATEWAY_ABUSE_CONFIG.auditLedger.maxRecords,
      ),
      redactPayloads:
        typeof auditLedger.redactPayloads === "boolean"
          ? auditLedger.redactPayloads
          : DEFAULT_GATEWAY_ABUSE_CONFIG.auditLedger.redactPayloads,
    },
  };

  validateResolvedGatewayAbuseConfig(resolved);
  return resolved;
}
