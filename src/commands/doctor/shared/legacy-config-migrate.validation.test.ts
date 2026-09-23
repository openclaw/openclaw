// Legacy config migration validation tests cover schema validation after doctor migrations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { prepareLegacyConfigMigrationRuntime } from "./legacy-config-migrate.test-support.js";

let restoreMigrationRuntime: (() => void) | undefined;

beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

describe("legacy config migrate validation", () => {
  it.each([0, 1000.9, 7_200_000])("preserves restored MCP idle TTL %s", (sessionIdleTtlMs) => {
    const raw = {
      mcp: { sessionIdleTtlMs },
      cron: { maxConcurrentRuns: 2 },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.config?.mcp?.sessionIdleTtlMs).toBe(sessionIdleTtlMs);
    expect(result.partiallyValid).toBeUndefined();
  });

  it("restores a schema-valid ambient owner after explicit roster normalization", () => {
    const raw = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config?.agents?.defaults?.systemAgent?.agentId).toBe("main");
    expect(result.config?.agents?.defaults?.heartbeat?.agentId).toBe("main");
  });

  let profileConfiguredToolAllowResult: ReturnType<typeof migrateLegacyConfig>;

  beforeAll(() => {
    const raw = {
      tools: {
        profile: "messaging",
        allow: ["message", "exec", "process"],
        exec: { security: "allowlist" },
      },
    };
    profileConfiguredToolAllowResult = migrateLegacyConfig(raw, {
      sourceConfigBeforeMigrations: raw,
    });
  });

  it("returns valid config when migrating profiled tool sections with an existing allowlist", () => {
    const res = profileConfiguredToolAllowResult;

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.tools?.allow).toEqual(["message", "exec", "process"]);
    expect(res.config?.tools?.profile).toBe("full");
    expect(res.config?.tools?.alsoAllow).toBeUndefined();
    expect(res.changes).toStrictEqual([
      'Replaced tools.allow entries with profile "messaging" grants plus explicit configured-section grants.',
      'Set tools.profile to "full" so tools.allow controls explicit configured-section grants directly.',
    ]);
  });

  it("returns schema-valid config after removing unsupported OTel grpc", () => {
    const raw = {
      diagnostics: {
        otel: {
          enabled: true,
          endpoint: "http://otel-collector:4317",
          protocol: "grpc",
        },
      },
    };
    const res = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.diagnostics?.otel).toEqual({
      enabled: false,
      endpoint: "http://otel-collector:4317",
    });
  });

  it("validates resolved OTel values while retaining authored interpolation", () => {
    const authored = {
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "${OTEL_LOGS_EXPORTER}",
          protocol: "grpc",
        },
      },
    };
    const resolved = {
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "stdout",
          protocol: "grpc",
        },
      },
    };

    const res = migrateLegacyConfig(authored, {
      sourceConfigBeforeMigrations: resolved,
      context: {
        authoredRaw: authored,
        resolvedRaw: resolved,
      },
    });

    expect(res.partiallyValid).toBeUndefined();
    expect(res.config?.diagnostics?.otel?.logsExporter).toBe("stdout");
    expect(res.sourceConfig?.diagnostics?.otel?.logsExporter).toBe("${OTEL_LOGS_EXPORTER}");
    expect(res.config?.diagnostics?.otel?.protocol).toBeUndefined();
    expect(res.sourceConfig?.diagnostics?.otel?.protocol).toBeUndefined();
  });
});
