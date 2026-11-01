import { afterEach, expect, it, vi } from "vitest";
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
  const result = validateConfigObjectRawWithPlugins(config, { pluginMetadataSnapshot });
  if (!result.ok) {
    throw new Error("Expected valid utility route");
  }
  return result;
}

const withDefaults = (
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] | false = { worker: {} },
) => ({ agents: { defaults, ...(entries ? { entries } : {}) } });
const metadata = (
  plugin: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"][number],
) => createPluginMetadataSnapshotFixture({ plugins: [plugin] });

const runtimeModel = (id: string) => ({ agentRuntime: { id } });
const warning = (model: string) => ({
  path: "agents.defaults.utilityModel",
  message: expect.stringContaining(`Utility model "${model}" uses CLI backend "fixture-cli"`),
});
const capableBackend = {
  ...unsupportedBackend,
  nativeToolMode: "selectable",
  toolAvailabilityEnforcement: "execution-args",
  resolveExecutionArgs: () => [],
} satisfies CliBackendPlugin;

it("accepts the explicit route and warns before its exact tool cap fails at runtime", () => {
  const utilityModel = { primary: "fixture-cli/small", fallbacks: ["local/capable"] };
  const result = validate(withDefaults({ utilityModel }));
  expect(result.warnings).toContainEqual(warning("fixture-cli/small"));
});

it("points per-agent warnings at the authored entry ID", () => {
  const utilityModel = "fixture-cli/small";
  const result = validate({ agents: { entries: { Worker: { utilityModel } } } });

  expect(result.warnings).toContainEqual(
    expect.objectContaining({ path: "agents.entries.Worker.utilityModel" }),
  );
});

it("resolves manifest model aliases before checking the canonical runtime pin", () => {
  const utilityModel = "local/small";
  const result = validate(
    withDefaults(
      { utilityModel, models: { "local/canonical": runtimeModel("fixture-cli") } },
      false,
    ),
    [unsupportedBackend],
    metadata({
      id: "local",
      modelIdNormalization: { providers: { local: { aliases: { small: "canonical" } } } },
    }),
  );

  expect(result.warnings).toContainEqual(warning("local/canonical"));
});

it.each([
  { runtime: undefined, warnings: 1 },
  { runtime: "openclaw", warnings: 0 },
])("checks explicit CLI auth profiles with runtime $runtime", ({ runtime, warnings }) => {
  const utilityModel = "local/small@fixture-cli-profile";
  const result = validate(
    {
      auth: { profiles: { "fixture-cli-profile": { provider: "fixture-cli", mode: "oauth" } } },
      ...withDefaults(
        {
          utilityModel,
          ...(runtime ? { models: { "local/small": runtimeModel(runtime) } } : {}),
        },
        false,
      ),
    },
    [unsupportedBackend],
    metadata({
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
    }),
  );

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
  expect(result.warnings.filter(({ message }) => message.startsWith("Utility model"))).toHaveLength(
    expected,
  );
});

it.each([
  { nativeToolMode: "selectable", toolAvailabilityEnforcement: "execution-args" },
  { nativeToolMode: "always-on", toolAvailabilityEnforcement: "execution-args" },
  { nativeToolMode: "selectable", toolAvailabilityEnforcement: "prepare-execution" },
] as const)("requires the registered exact-cap adapter, not just its declaration: %j", (policy) => {
  const result = validate(
    withDefaults(
      { utilityModel: "helper" },
      {
        worker: { models: { "local/small": { alias: "helper", ...runtimeModel("fixture-cli") } } },
      },
    ),
    [{ ...unsupportedBackend, ...policy }],
  );
  expect(result.warnings).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining('Utility model "local/small"'),
    }),
  );
});

it.each(["execution-args", "prepare-execution"] as const)(
  "keeps a capable CLI route quiet: %s",
  (toolAvailabilityEnforcement) => {
    const result = validate(withDefaults({ utilityModel: "fixture-cli/small" }), [
      { ...capableBackend, toolAvailabilityEnforcement, prepareExecution: () => undefined },
    ]);
    expect(result.warnings).toEqual([]);
  },
);

it("respects a mapped runtime pin on a standalone CLI provider", () => {
  const result = validate(
    withDefaults({
      utilityModel: "fixture-cli/small",
      models: { "fixture-cli/small": runtimeModel("capable-cli") },
    }),
    [
      { ...unsupportedBackend, modelProvider: undefined },
      { ...capableBackend, id: "capable-cli", modelProvider: "fixture-cli" },
    ],
  );
  expect(result.warnings).toEqual([]);
});

it("resolves each utility backend once per validation and refreshes misses on the next config", () => {
  const config = withDefaults(
    { utilityModel: { primary: "fixture-cli/small", fallbacks: ["local/capable"] } },
    { first: {}, second: {}, third: {} },
  );
  const roster = { agents: { ...config.agents, ownership: "explicit" as const } };
  const lookup = vi.fn();
  let available = false;
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupCliBackend: ({ backend }) => {
      lookup(backend);
      return available && backend === "fixture-cli"
        ? { pluginId: "fixture", backend: unsupportedBackend }
        : undefined;
    },
  });
  for (const enabled of [false, true, false]) {
    available = enabled;
    lookup.mockClear();
    const result = validateConfigObjectRawWithPlugins(structuredClone(roster), {
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.warnings).toEqual(enabled ? [warning("fixture-cli/small")] : []);
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(["fixture-cli", "local"]);
  }
});
