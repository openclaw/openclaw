import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const unsupportedBackend = {
  id: "fixture-cli",
  modelProvider: "local",
  config: { command: "fixture" },
  nativeToolMode: "always-on",
  ownsNativeCompaction: false,
  runtimeArtifact: {
    kind: "bundled-package-tree",
    packageName: "@fixture/cli",
    entrypoint: "command",
  },
} satisfies CliBackendPlugin;

afterEach(() => cliBackendsTesting.resetDepsForTest());

function validate(
  config: OpenClawConfig,
  backends: readonly CliBackendPlugin[] = [unsupportedBackend],
  pluginMetadataSnapshot = createPluginMetadataSnapshotFixture(),
) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupCliBackend: ({ backend: id }) => {
      const backend = backends.find((entry) => entry.id === id);
      return backend ? { pluginId: "fixture", backend } : undefined;
    },
  });
  return validateConfigObjectRawWithPlugins(config, { pluginMetadataSnapshot });
}

describe("utility model capability warnings", () => {
  it("accepts the explicit route and warns before its exact tool cap fails at runtime", () => {
    const utilityModel = { primary: "fixture-cli/small", fallbacks: ["local/capable"] };
    const result = validate({ agents: { defaults: { utilityModel }, entries: { worker: {} } } });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid utility route");
    }
    expect(result.config.agents?.defaults?.utilityModel).toEqual(utilityModel);
    expect(result.warnings).toContainEqual({
      path: "agents.defaults.utilityModel",
      message:
        'Utility model "fixture-cli/small" uses CLI backend "fixture-cli", which cannot enforce the tool-free utility contract. Choose a capable utility model or add capable utilityModel fallbacks; the explicit route is unchanged.',
    });
  });

  it("points per-agent warnings at the authored entry ID", () => {
    const utilityModel = "fixture-cli/small";
    const result = validate({ agents: { entries: { Worker: { utilityModel } } } });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid utility route");
    }
    expect(result.config.agents?.entries?.Worker?.utilityModel).toBe(utilityModel);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ path: "agents.entries.Worker.utilityModel" }),
    );
  });

  it("resolves manifest model aliases before checking the canonical runtime pin", () => {
    const utilityModel = "local/small";
    const result = validate(
      {
        agents: {
          defaults: {
            utilityModel,
            models: { "local/canonical": { agentRuntime: { id: "fixture-cli" } } },
          },
        },
      },
      [unsupportedBackend],
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "local",
            modelIdNormalization: {
              providers: { local: { aliases: { small: "canonical" } } },
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid utility route");
    }
    expect(result.config.agents?.defaults?.utilityModel).toBe(utilityModel);
    expect(result.warnings).toContainEqual({
      path: "agents.defaults.utilityModel",
      message:
        'Utility model "local/canonical" uses CLI backend "fixture-cli", which cannot enforce the tool-free utility contract. Choose a capable utility model or add capable utilityModel fallbacks; the explicit route is unchanged.',
    });
  });

  it.each([
    { runtime: undefined, warnings: 1 },
    { runtime: "openclaw", warnings: 0 },
  ])("checks explicit CLI auth profiles with runtime $runtime", ({ runtime, warnings }) => {
    const utilityModel = "local/small@fixture-cli-profile";
    const result = validate(
      {
        auth: { profiles: { "fixture-cli-profile": { provider: "fixture-cli", mode: "oauth" } } },
        agents: {
          defaults: {
            utilityModel,
            ...(runtime ? { models: { "local/small": { agentRuntime: { id: runtime } } } } : {}),
          },
        },
      },
      [unsupportedBackend],
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "local",
            providerAuthChoices: [
              {
                provider: "local",
                method: "cli",
                choiceId: "local-cli",
                deprecatedChoiceIds: ["fixture-cli"],
                choiceLabel: "Fixture CLI",
              },
            ],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid utility route");
    }
    expect(result.config.agents?.defaults?.utilityModel).toBe(utilityModel);
    expect(result.warnings).toHaveLength(warnings);
  });

  it.each([
    { override: "local/capable", expected: 0 },
    { override: "", expected: 0 },
    { override: { fallbacks: [] }, expected: 0 },
    { override: undefined, expected: 1 },
  ])("warns only for effective fallback routes: %j", ({ override, expected }) => {
    const result = validate({
      agents: {
        defaults: {
          utilityModel: { primary: "local/capable", fallbacks: ["fixture-cli/small"] },
        },
        entries: { worker: { utilityModel: override } },
      },
    });
    expect(result.ok).toBe(true);
    expect(
      result.warnings.filter(({ message }) => message.startsWith("Utility model")),
    ).toHaveLength(expected);
  });

  it.each([
    { nativeToolMode: "selectable", toolAvailabilityEnforcement: "execution-args" },
    { nativeToolMode: "always-on", toolAvailabilityEnforcement: "execution-args" },
    { nativeToolMode: "selectable", toolAvailabilityEnforcement: "prepare-execution" },
  ] as const)(
    "requires the registered exact-cap adapter, not just its declaration: %j",
    (policy) => {
      const result = validate(
        {
          agents: {
            defaults: { utilityModel: "helper" },
            entries: {
              worker: {
                models: { "local/small": { alias: "helper", agentRuntime: { id: "fixture-cli" } } },
              },
            },
          },
        },
        [{ ...unsupportedBackend, ...policy }],
      );
      expect(result.ok).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Utility model "local/small"'),
        }),
      );
    },
  );

  it.each(["execution-args", "prepare-execution"] as const)(
    "keeps a capable CLI route quiet: %s",
    (toolAvailabilityEnforcement) => {
      const result = validate(
        { agents: { defaults: { utilityModel: "fixture-cli/small" }, entries: { worker: {} } } },
        [
          {
            ...unsupportedBackend,
            nativeToolMode: "selectable",
            toolAvailabilityEnforcement,
            resolveExecutionArgs: () => [],
            prepareExecution: () => undefined,
          },
        ],
      );
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    },
  );

  it("respects a mapped runtime pin on a standalone CLI provider", () => {
    const result = validate(
      {
        agents: {
          defaults: {
            utilityModel: "fixture-cli/small",
            models: { "fixture-cli/small": { agentRuntime: { id: "capable-cli" } } },
          },
          entries: { worker: {} },
        },
      },
      [
        { ...unsupportedBackend, modelProvider: undefined },
        {
          ...unsupportedBackend,
          id: "capable-cli",
          modelProvider: "fixture-cli",
          nativeToolMode: "selectable",
          toolAvailabilityEnforcement: "execution-args",
          resolveExecutionArgs: () => [],
        },
      ],
    );
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
