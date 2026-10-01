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

  it.each(["entries", "list"] as const)(
    "restores supported agent aliases and WebChat config through the registry (%s)",
    (shape) => {
      const entry = {
        embeddedPi: { executionContract: "strict-agentic" },
        embeddedAgent: { executionContract: "default" },
        embeddedHarness: { runtime: "pi" },
        sandbox: { perSession: true, scope: "agent" },
      };
      const raw = {
        agents: {
          defaults: {
            embeddedPi: {
              projectSettingsPolicy: "sanitize",
              executionContract: "strict-agentic",
            },
            embeddedAgent: { projectSettingsPolicy: "trusted" },
            embeddedHarness: { runtime: "pi" },
            sandbox: { perSession: false },
          },
          ...(shape === "entries"
            ? { entries: { main: entry } }
            : { list: [{ id: "main", ...entry }] }),
        },
        gateway: { mode: "local", port: 18790, webchat: { chatHistoryMaxChars: 48_000 } },
      };
      const original = structuredClone(raw);
      const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(result.partiallyValid).toBeUndefined();
      expect(result.sourceConfig?.agents?.defaults).toEqual({
        embeddedAgent: { projectSettingsPolicy: "trusted", executionContract: "strict-agentic" },
        sandbox: { scope: "shared" },
      });
      expect(result.sourceConfig?.agents?.entries?.main).toEqual({
        embeddedAgent: { executionContract: "default" },
        sandbox: { scope: "agent" },
      });
      expect(result.sourceConfig?.gateway).toEqual({ mode: "local", port: 18790 });
      expect(raw).toEqual(original);
      expect(
        migrateLegacyConfig(result.sourceConfig, {
          sourceConfigBeforeMigrations: result.sourceConfig,
        }).changes,
      ).toEqual([]);
    },
  );

  it.each([
    {
      defaults: { perSession: false },
      agent: { perSession: true },
      expected: { scope: "session" },
    },
    { defaults: { scope: "agent" }, agent: { perSession: true }, expected: {} },
  ])(
    "preserves the effective sandbox scope when defaults are $defaults",
    ({ defaults, agent, expected }) => {
      const raw = {
        agents: { defaults: { sandbox: defaults }, entries: { ops: { sandbox: agent } } },
      };
      const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
      expect(result.partiallyValid).toBeUndefined();
      expect(result.sourceConfig?.agents?.entries?.ops?.sandbox).toEqual(expected);
    },
  );

  it("keeps invalid sandbox aliases visible to validation", () => {
    const raw = {
      agents: { defaults: { sandbox: { perSession: "yes" } } },
      session: { typingMode: "thinking" },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBe(true);
    expect(result.config?.agents?.defaults?.sandbox).toEqual({ perSession: "yes" });
  });

  it("preserves the restored MCP idle TTL during migration", () => {
    const raw = { mcp: { sessionIdleTtlMs: 1000.9 }, cron: { maxConcurrentRuns: 2 } };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.config?.mcp?.sessionIdleTtlMs).toBe(1000.9);
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
