import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshot } from "../../../config/mutate.test-support.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";

const { migrateLegacyConfigMock, stripUnknownConfigKeysMock, noteMock } = vi.hoisted(() => ({
  migrateLegacyConfigMock: vi.fn(),
  stripUnknownConfigKeysMock: vi.fn(),
  noteMock: vi.fn(),
}));

// mock-isolation: Exercise flow decisions with a fixed migration result, not plugin discovery.
vi.mock("./legacy-config-migrate.js", () => ({ migrateLegacyConfig: migrateLegacyConfigMock }));

vi.mock("../../doctor-config-analysis.js", () => ({
  stripUnknownConfigKeys: stripUnknownConfigKeysMock,
}));

// mock-isolation: Capture the public flow's terminal diagnostics without rendering them.
vi.mock("../../../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/terminal-core/src/note.js")>()),
  note: noteMock,
}));

import { applyLegacyCompatibilityStep, applyRetiredConfigStep } from "./config-flow-steps.js";

function createLegacyStepResult(
  snapshot: Pick<ConfigFileSnapshot, "parsed" | "legacyIssues"> & Partial<ConfigFileSnapshot>,
  sourceConfig: OpenClawConfig = {},
) {
  return applyLegacyCompatibilityStep({
    snapshot: {
      ...createSnapshot({ hash: "fixture", path: "/tmp/config.json", sourceConfig }),
      raw: "{}",
      ...snapshot,
    },
    state: mutationState(),
    shouldRepair: false,
    doctorFixCommand: "openclaw doctor --fix",
  });
}

function mutationState(candidate: OpenClawConfig = {}) {
  return { cfg: {}, candidate, pendingChanges: false, fixHints: [] };
}

async function repairAfterAuthKeyCleanup(
  profileId: string,
  metadata: Record<string, unknown>,
  model: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"],
  withProvider = true,
) {
  const candidate = {
    auth: { profiles: { [profileId]: metadata } },
    ...(withProvider ? { models: { providers: { openai: { apiKey: "${OPENAI_API_KEY}" } } } } : {}),
    agents: { defaults: { model } },
  } as unknown as OpenClawConfig;
  const config = structuredClone(candidate);
  Reflect.deleteProperty(
    expectDefined(config.auth?.profiles?.[profileId], "auth profile fixture"),
    "key",
  );
  stripUnknownConfigKeysMock.mockReturnValueOnce({
    config,
    removed: [`auth.profiles.${profileId}.key`],
  });
  const changes: string[] = [];
  const state = await applyRetiredConfigStep({
    state: mutationState(candidate),
    shouldRepair: true,
    doctorFixCommand: "openclaw doctor --fix",
    sourceConfig: candidate,
    emitChanges: (lines) => changes.push(...lines),
  });
  return { state, changes };
}

describe("doctor config flow steps", () => {
  beforeEach(() => {
    migrateLegacyConfigMock.mockReset().mockImplementation((config: OpenClawConfig) => ({
      config,
      changes: [],
    }));
    stripUnknownConfigKeysMock.mockReset();
    noteMock.mockClear();
  });

  it("blocks grpc migration when include ownership is ambiguous and names every source", () => {
    const sourceConfig = {
      diagnostics: { otel: { enabled: true, protocol: "grpc" } },
    } as unknown as OpenClawConfig;
    const result = createLegacyStepResult(
      {
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
        legacyIssues: [{ path: "diagnostics.otel.protocol", message: "grpc is unsupported" }],
        valid: false,
      },
      sourceConfig,
    );

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

  it("does not queue a write for deferred-only legacy advice without a candidate", () => {
    const config = { agents: { entries: { main: {} }, defaults: { models: { bare: {} } } } };
    migrateLegacyConfigMock.mockReturnValueOnce({ config: null, changes: [] });
    const result = createLegacyStepResult(
      {
        parsed: config,
        raw: JSON.stringify(config),
        sourceConfigBeforeMigrations: config,
        legacyIssues: [
          {
            path: "agents.defaults.models",
            message: "Legacy model restriction retained; set an explicit policy.",
          },
        ],
      },
      config,
    );
    expect(result.issueLines).toEqual([
      "- agents.defaults.models: Legacy model restriction retained; set an explicit policy.",
    ]);
    expect(result.changeLines).toEqual([]);
    expect(result.state.pendingChanges).toBe(false);
    expect(result.state.fixHints).toEqual([]);
  });

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

  it("removes unknown keys and adds preview hint", async () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({ config: {}, removed: ["bogus"] });

    const candidate = { bogus: true } as unknown as OpenClawConfig;
    const state = await applyRetiredConfigStep({
      state: mutationState(candidate),
      shouldRepair: false,
      doctorFixCommand: "openclaw doctor --fix",
      sourceConfig: candidate,
      emitChanges: vi.fn(),
    });

    expect(noteMock).toHaveBeenCalledWith("- bogus", "Unknown config keys");
    expect(state.candidate).toStrictEqual({});
    expect(state.fixHints).toStrictEqual(['Run "openclaw doctor --fix" to remove these keys.']);
  });

  it.each([
    [
      "openai:default",
      { key: "sk-test" },
      { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.5"] },
      ["Repaired auth.profiles.openai:default metadata for active openai auth."],
    ],
    [
      "openai:default",
      { provider: "openai", mode: "api_key", key: "sk-test" },
      { fallbacks: ["openai/gpt-5.5"] },
      [],
    ],
    [
      "work",
      { key: "sk-test" },
      { primary: "openai/gpt-5.5@work" },
      ["Repaired auth.profiles.work metadata for active openai auth."],
    ],
  ])(
    "normalizes %s metadata %j after unknown-key cleanup",
    async (profileId, metadata, model, repairs) => {
      const result = await repairAfterAuthKeyCleanup(
        profileId,
        metadata,
        model,
        profileId !== "work",
      );
      expect(result.changes).toStrictEqual([
        `- auth.profiles.${profileId}.key`,
        ...repairs.map((repair) => `- ${repair}`),
      ]);
      expect(noteMock).not.toHaveBeenCalled();
      expect(result.state.cfg.auth?.profiles?.[profileId]).toEqual({
        provider: "openai",
        mode: "api_key",
      });
    },
  );
});
