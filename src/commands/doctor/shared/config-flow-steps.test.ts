// Config-flow step tests cover doctor repair step ordering and mutation planning.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";

const { migrateLegacyConfigMock, stripUnknownConfigKeysMock } = vi.hoisted(() => ({
  migrateLegacyConfigMock: vi.fn(),
  stripUnknownConfigKeysMock: vi.fn(),
}));

vi.mock("./legacy-config-migrate.js", () => ({
  migrateLegacyConfig: migrateLegacyConfigMock,
}));

vi.mock("../../doctor-config-analysis.js", () => ({
  stripUnknownConfigKeys: stripUnknownConfigKeysMock,
}));

import { applyLegacyCompatibilityStep, applyUnknownConfigKeyStep } from "./config-flow-steps.js";

function createLegacyStepResult(
  snapshot: Pick<ConfigFileSnapshot, "parsed" | "legacyIssues"> & Partial<ConfigFileSnapshot>,
  doctorFixCommand = "openclaw doctor --fix",
) {
  return applyLegacyCompatibilityStep({
    snapshot: {
      exists: true,
      path: "/tmp/config.json",
      valid: true,
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      issues: [],
      warnings: [],
      ...snapshot,
    },
    state: {
      cfg: {},
      candidate: {},
      pendingChanges: false,
      fixHints: [],
    },
    shouldRepair: false,
    doctorFixCommand,
  });
}

function repairAfterAuthKeyCleanup(candidate: OpenClawConfig, profileId: string) {
  const config = structuredClone(candidate);
  const profile = config.auth?.profiles?.[profileId];
  if (!profile) {
    throw new Error(`Missing auth profile fixture: ${profileId}`);
  }
  Reflect.deleteProperty(profile, "key");
  stripUnknownConfigKeysMock.mockReturnValueOnce({
    config,
    removed: [`auth.profiles.${profileId}.key`],
  });
  return applyUnknownConfigKeyStep({
    state: { cfg: {}, candidate, pendingChanges: false, fixHints: [] },
    shouldRepair: true,
    doctorFixCommand: "openclaw doctor --fix",
  });
}

describe("doctor config flow steps", () => {
  beforeEach(() => {
    migrateLegacyConfigMock.mockReset();
    migrateLegacyConfigMock.mockImplementation((config: OpenClawConfig) => ({
      config,
      changes: [],
    }));
    stripUnknownConfigKeysMock.mockReset();
  });

  it("collects legacy compatibility issue lines and preview fix hints", () => {
    migrateLegacyConfigMock.mockReturnValueOnce({
      config: {},
      changes: ["Moved session.typingMode → agents.defaults.typingMode."],
    });

    const result = createLegacyStepResult({
      parsed: { session: { typingMode: "thinking" } },
      legacyIssues: [{ path: "session.typingMode", message: "use agents.defaults.typingMode" }],
    });

    expect(result.issueLines).toEqual(["- session.typingMode: use agents.defaults.typingMode"]);
    expect(result.changeLines).not.toStrictEqual([]);
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    ]);
    expect(result.state.pendingChanges).toBe(true);
  });

  it("migrates the resolved config so single-file include values are repairable", () => {
    const sourceConfig = {
      mcp: { servers: { local: { command: "node", disabled: true } } },
    } as unknown as OpenClawConfig;
    migrateLegacyConfigMock.mockReturnValueOnce({
      config: {
        commands: { native: "auto" },
        mcp: { servers: { local: { command: "node", enabled: false } } },
      },
      sourceConfig: { mcp: { servers: { local: { command: "node", enabled: false } } } },
      changes: ["Moved mcp.servers.local.disabled true → enabled false."],
    });

    const result = createLegacyStepResult({
      parsed: { mcp: { $include: "./mcp.json5" } },
      legacyIssues: [{ path: "mcp.servers", message: "disabled is legacy" }],
      valid: false,
      resolved: sourceConfig,
      sourceConfig,
      config: sourceConfig,
      runtimeConfig: sourceConfig,
    });

    expect(migrateLegacyConfigMock).toHaveBeenCalledWith(sourceConfig, {
      sourceConfigBeforeMigrations: undefined,
      context: {
        authoredRaw: { mcp: { $include: "./mcp.json5" } },
        resolvedRaw: sourceConfig,
      },
    });
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.mcp?.servers?.local?.enabled).toBe(false);
    expect(result.state.candidate.commands).toBeUndefined();
  });

  it("blocks grpc migration when include ownership is ambiguous and names every source", () => {
    const sourceConfig = {
      diagnostics: { otel: { enabled: true, protocol: "grpc" } },
    } as unknown as OpenClawConfig;
    const result = createLegacyStepResult({
      parsed: { diagnostics: { $include: ["./a.json5", "./b.json5"] } },
      includeProvenance: [
        {
          path: ["diagnostics"],
          kind: "multiple",
          hasSiblingOverrides: false,
          hasArrayAncestor: false,
          targetPaths: ["/tmp/a.json5", "/tmp/b.json5"],
        },
      ],
      legacyIssues: [
        {
          path: "diagnostics.otel.protocol",
          message: "grpc is unsupported",
        },
      ],
      valid: false,
      resolved: sourceConfig,
      sourceConfig,
      config: sourceConfig,
      runtimeConfig: sourceConfig,
    });

    expect(migrateLegacyConfigMock).not.toHaveBeenCalled();
    expect(result.blocksWrite).toBe(true);
    expect(result.changeLines).toStrictEqual([]);
    expect(result.issueLines.join("\n")).toContain(
      'Inspect these candidate source files and remove or replace diagnostics.otel.protocol = "grpc" from every definition: /tmp/a.json5, /tmp/b.json5.',
    );
    expect(result.issueLines.join("\n")).toContain("No config files were changed.");
  });

  it("keeps pending repair state for legacy issues even when the snapshot is already normalized", () => {
    const result = createLegacyStepResult({
      parsed: { talk: { voiceId: "voice-1", modelId: "eleven_v3" } },
      legacyIssues: [
        {
          path: "talk",
          message: "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
        },
      ],
    });

    expect(result.changeLines).toStrictEqual([]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    ]);
  });

  it.each([false, true])(
    "does not queue a write for deferred-only legacy advice (candidate %s)",
    (hasCandidate) => {
      const config = { agents: { entries: { main: {} }, defaults: { models: { bare: {} } } } };
      migrateLegacyConfigMock.mockReturnValueOnce({
        config: hasCandidate ? config : null,
        changes: [],
      });
      const result = createLegacyStepResult({
        parsed: config,
        raw: JSON.stringify(config),
        sourceConfigBeforeMigrations: config,
        sourceConfig: config,
        resolved: config,
        config,
        runtimeConfig: config,
        legacyIssues: [
          {
            path: "agents.defaults.models",
            message: "Legacy model restriction retained; set an explicit policy.",
          },
        ],
      });
      expect(result.issueLines).toEqual([
        "- agents.defaults.models: Legacy model restriction retained; set an explicit policy.",
      ]);
      expect(result.changeLines).toEqual([]);
      expect(result.state.pendingChanges).toBe(false);
      expect(result.state.fixHints).toEqual([]);
    },
  );

  it("commits migration even when post-migration validation has unrelated issues (#76798)", () => {
    const migratedConfig = { agents: { defaults: { typingMode: "thinking" } }, session: {} };
    migrateLegacyConfigMock.mockReturnValueOnce({
      config: migratedConfig,
      changes: ["Moved session.typingMode → agents.defaults.typingMode."],
      partiallyValid: true,
    });

    const result = createLegacyStepResult({
      parsed: {
        session: { typingMode: "thinking" },
        tools: { web: { search: { provider: "brave" } } },
      },
      legacyIssues: [{ path: "session.typingMode", message: "deprecated key" }],
      valid: false,
      issues: [
        {
          path: "tools.web.search.provider",
          message: "web_search provider is not available: brave",
        },
      ],
    });

    expect(result.state.candidate).toEqual(migratedConfig);
    expect(result.state.cfg).toEqual(migratedConfig);
    expect(result.state.pendingChanges).toBe(true);
  });

  it("removes unknown keys and adds preview hint", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {},
      removed: ["bogus"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: { bogus: true } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: false,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.removed).toEqual(["bogus"]);
    expect(result.state.candidate).toStrictEqual({});
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to remove these keys.',
    ]);
  });

  it("repairs active malformed auth profile metadata after unknown-key cleanup", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            "openai:default": { key: "sk-test" },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      } as unknown as OpenClawConfig,
      "openai:default",
    );

    expect(result.repairs).toEqual([
      "Repaired auth.profiles.openai:default metadata for active openai auth.",
    ]);
    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("keeps valid active auth profile metadata while stripping stale secret fields", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "api_key",
              key: "sk-test",
            },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
          },
        },
        agents: {
          defaults: {
            model: {
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      } as unknown as OpenClawConfig,
      "openai:default",
    );

    expect(result.repairs).toStrictEqual([]);
    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("repairs non-default auth profiles for active providers", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            "openai:work": { key: "sk-test" },
          },
        },
        agents: {
          defaults: {
            model: {
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      } as unknown as OpenClawConfig,
      "openai:work",
    );

    expect(result.repairs).toEqual([
      "Repaired auth.profiles.openai:work metadata for active openai auth.",
    ]);
    expect(result.state.cfg.auth?.profiles?.["openai:work"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("preserves explicit model auth profile refs during unknown-key cleanup", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            "openai:default": { key: "sk-test" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5@openai:default",
            },
          },
        },
      } as unknown as OpenClawConfig,
      "openai:default",
    );

    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("infers providers for bare auth profile suffixes", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            work: { key: "sk-test" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5@work",
            },
          },
        },
      } as unknown as OpenClawConfig,
      "work",
    );

    expect(result.warnings).toStrictEqual([]);
    expect(result.state.cfg.auth?.profiles?.work).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("protects auth profiles referenced only by channel model overrides", () => {
    const result = repairAfterAuthKeyCleanup(
      {
        auth: {
          profiles: {
            "openai:default": { key: "sk-test" },
          },
        },
        channels: {
          modelByChannel: {
            slack: {
              C123: "openai/gpt-5.5@openai:default",
            },
          },
        },
      } as unknown as OpenClawConfig,
      "openai:default",
    );

    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });
});
