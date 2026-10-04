import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { prepareLegacyConfigMigrationRuntime } from "./legacy-config-migrate.test-support.js";

let restoreMigrationRuntime: (() => void) | undefined;
beforeAll(async () => {
  restoreMigrationRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreMigrationRuntime?.());

describe("legacy config migrate validation", () => {
  it("leaves retired keys unresolved while migrating supported config", () => {
    const raw = {
      heartbeat: { every: "30m", showOk: true },
      agents: {
        defaults: {
          llm: { idleTimeoutSeconds: 120 },
        },
      },
      session: { typingMode: "thinking" },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBe(true);
    expect(result.config).toEqual({
      ...raw,
      agents: { defaults: { ...raw.agents.defaults, typingMode: "thinking" } },
      session: {},
    });
    expect(result.changes).toEqual([
      "Moved session.typingMode → agents.defaults.typingMode.",
      "Migration applied; other validation issues remain — run doctor to review.",
    ]);
    expect(raw.session.typingMode).toBe("thinking");
  });

  it("preserves supported concurrency and MCP idle TTL during migration", () => {
    const raw = {
      mcp: { sessionIdleTtlMs: 1000.9 },
      cron: { maxConcurrentRuns: 2 },
      session: { typingMode: "thinking" },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.config?.mcp?.sessionIdleTtlMs).toBe(1000.9);
    expect(result.config?.cron?.maxConcurrentRuns).toBe(2);
    expect(result.partiallyValid).toBeUndefined();
  });

  it("restores a schema-valid ambient owner after explicit roster normalization", () => {
    const raw = { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config?.agents?.defaults?.systemAgent?.agentId).toBe("main");
    expect(result.config?.agents?.defaults?.heartbeat?.agentId).toBe("main");
  });

  it("validates resolved OTel values while retaining authored interpolation", () => {
    const otel = {
      enabled: true,
      traces: false,
      metrics: false,
      logs: true,
      protocol: "grpc",
    };
    const authored = {
      diagnostics: { otel: { ...otel, logsExporter: "${OTEL_LOGS_EXPORTER}" } },
    };
    const resolved = { diagnostics: { otel: { ...otel, logsExporter: "stdout" } } };
    const result = migrateLegacyConfig(authored, {
      sourceConfigBeforeMigrations: resolved,
      context: { authoredRaw: authored, resolvedRaw: resolved },
    });
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config?.diagnostics?.otel?.logsExporter).toBe("stdout");
    expect(result.sourceConfig?.diagnostics?.otel?.logsExporter).toBe("${OTEL_LOGS_EXPORTER}");
    expect(result.config?.diagnostics?.otel?.protocol).toBeUndefined();
    expect(result.sourceConfig?.diagnostics?.otel?.protocol).toBeUndefined();
  });
});
