import { describe, expect, it } from "vitest";
import { resolveGatewayAbuseConfig } from "./abuse-config.js";

describe("resolveGatewayAbuseConfig", () => {
  it("returns defaults when gateway.abuse is unset", () => {
    const resolved = resolveGatewayAbuseConfig({});

    expect(resolved.quota.mode).toBe("off");
    expect(resolved.quota.burstLimit).toBe(20);
    expect(resolved.anomaly.mode).toBe("off");
    expect(resolved.anomaly.blockThreshold).toBe(90);
    expect(resolved.correlation.mode).toBe("off");
    expect(resolved.incident.autoContainment.enabled).toBe(false);
    expect(resolved.auditLedger.redactPayloads).toBe(true);
  });

  it("merges config values and explicit runtime overrides", () => {
    const resolved = resolveGatewayAbuseConfig(
      {
        gateway: {
          abuse: {
            quota: {
              mode: "observe",
              burstLimit: 30,
            },
            incident: {
              mode: "observe",
              autoContainment: {
                enabled: false,
                minSeverity: "warn",
              },
            },
          },
        },
      },
      {
        quota: {
          sustainedLimit: 300,
          sustainedWindowMs: 180_000,
        },
        incident: {
          autoContainment: {
            enabled: true,
            ttlMs: 120_000,
          },
        },
        auditLedger: {
          mode: "observe",
          retentionDays: 30,
        },
      },
    );

    expect(resolved.quota.mode).toBe("observe");
    expect(resolved.quota.burstLimit).toBe(30);
    expect(resolved.quota.sustainedLimit).toBe(300);
    expect(resolved.quota.sustainedWindowMs).toBe(180_000);

    expect(resolved.incident.mode).toBe("observe");
    expect(resolved.incident.autoContainment.enabled).toBe(true);
    expect(resolved.incident.autoContainment.minSeverity).toBe("warn");
    expect(resolved.incident.autoContainment.ttlMs).toBe(120_000);

    expect(resolved.auditLedger.mode).toBe("observe");
    expect(resolved.auditLedger.retentionDays).toBe(30);
  });

  it("rejects partial anomaly thresholds that invert ordering after defaults", () => {
    expect(() =>
      resolveGatewayAbuseConfig({
        gateway: {
          abuse: {
            anomaly: {
              warningThreshold: 70,
              blockThreshold: 80,
            },
          },
        },
      }),
    ).toThrow("gateway.abuse.anomaly.warningThreshold must be < throttleThreshold");
  });

  it("rejects partial quota windows that invert ordering after defaults", () => {
    expect(() =>
      resolveGatewayAbuseConfig({
        gateway: {
          abuse: {
            quota: {
              sustainedWindowMs: 5_000,
            },
          },
        },
      }),
    ).toThrow("gateway.abuse.quota.sustainedWindowMs must be >= burstWindowMs");
  });

  it("rejects partial correlation scores that invert ordering after defaults", () => {
    expect(() =>
      resolveGatewayAbuseConfig({
        gateway: {
          abuse: {
            correlation: {
              warningScore: 90,
            },
          },
        },
      }),
    ).toThrow("gateway.abuse.correlation.warningScore must be < criticalScore");
  });
});
