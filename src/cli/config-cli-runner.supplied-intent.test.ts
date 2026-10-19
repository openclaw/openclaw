import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreEnvVarRefsFromResolved } from "../config/env-preserve.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConfigSetOperation } from "./config-cli-input.js";
import { runConfigOperations } from "./config-cli-runner.js";

// Real runner, path/roster mutators and reference restoration; mocked snapshot,
// validation and persistence boundaries do not prove writer/topology or CLI acceptance.
const state = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  prepare: vi.fn(),
  replace: vi.fn(),
  unexpected: (operation: string): never => {
    throw new Error(`Unexpected ${operation}`);
  },
}));
vi.mock("../config/config.js", () => ({ replaceConfigFile: state.replace }));
vi.mock("./config-cli-validation.js", () => ({
  loadValidConfigForWrite: async () => ({ snapshot: state.snapshot, writeOptions: {} }),
  validateConfigMutation: async () => ({ kind: "write" }),
  assertStrictConfigForMutation: vi.fn(),
}));
// mock-isolation: Observe supplied write intent without preparing filesystem writes.
vi.mock("../config/io.write-prepare.js", () => ({ prepareConfigWriteValues: state.prepare }));
// mock-isolation: Fail if a real write unexpectedly enters the dry-run topology path.
vi.mock("../config/io.write-topology.js", () => ({
  prepareConfigWriteTopology: () => state.unexpected("dry-run topology"),
}));
// mock-isolation: Fail if the runner unexpectedly requests dry-run unset expansion.
vi.mock("../config/config-path-mutation.js", () => ({
  resolveManagedUnsetPathsForWrite: () => state.unexpected("dry-run unsets"),
}));
vi.mock("../config/io.meta.js", () => ({ AUTO_MANAGED_CONFIG_META_PATHS: [] }));
// mock-isolation: Keep the supplied synthetic snapshot intact at the reader boundary.
vi.mock("../config/io.read-helpers.js", () => ({ coerceConfig: (value: unknown) => value }));
vi.mock("../config/paths.js", () => ({
  resolveConfigPath: () => "/test/openclaw.json",
  resolveStateDir: vi.fn(),
}));
// mock-isolation: Reject unexpected redacted input without loading secret discovery.
vi.mock("../config/redact-snapshot.js", () => ({
  REDACTED_SENTINEL: "__OPENCLAW_REDACTED__",
  restoreRedactedValues: () => state.unexpected("redacted input"),
}));
vi.mock("../config/runtime-schema.js", () => ({
  readBestEffortRuntimeConfigSchema: async () => undefined,
}));
vi.mock("../gateway/config-diff.js", () => ({ diffConfigPaths: () => [] }));
vi.mock("../gateway/config-reload-plan.js", () => ({
  buildGatewayReloadPlan: () => ({ restartGateway: false, hotReasons: [] }),
}));
vi.mock("../gateway/config-reload-settings.js", () => ({
  resolveGatewayReloadSettings: () => ({ mode: "hybrid" }),
}));
vi.mock("../globals.js", () => ({ info: (s: string) => s, danger: (s: string) => s }));
vi.mock("../infra/errors.js", () => ({ formatErrorMessage: String }));
vi.mock("../runtime.js", () => ({
  ExitError: class ExitError extends Error {},
  writeRuntimeJson: vi.fn(),
}));
// mock-isolation: Keep metadata discovery outside this ordered path-intent runner boundary.
vi.mock("./config-cli-model-normalization.js", () => ({
  normalizeConfigMutationModelRefs: (value: unknown) => value,
  normalizeConfigMutationExplicitSetPath: (path: string[]) => path,
  shouldNormalizeConfigMutationProviderCatalogs: () => true,
}));
vi.mock("./config-set-dryrun.js", () => ({
  ConfigSetDryRunValidationError: class extends Error {},
  printConfigDryRunResult: vi.fn(),
}));
vi.mock("./one-shot-exit.js", () => ({ exitCliAfterOutput: vi.fn() }));
vi.mock("./command-format.js", () => ({ formatCliCommand: (s: string) => s }));
// Keep roster functions real, isolating only their workspace services.
vi.mock("../config/legacy.default-agent-owner-state.js", () => ({
  getRetainedLegacyDefaultAgentId: vi.fn(),
}));
vi.mock("../config/model-policy-allowlist-migration.js", () => ({
  hasExplicitModelPolicyAllow: vi.fn(),
}));
vi.mock("../agents/agent-dir-registry.js", () => ({ registerResolvedAgentDir: vi.fn() }));
vi.mock("../agents/workspace-default.js", () => ({ resolveDefaultAgentWorkspaceDir: vi.fn() }));
vi.mock("../routing/session-key.js", async () => ({
  ...(await import("@openclaw/normalization-core/agent-id")),
  LEGACY_IMPLICIT_AGENT_ID: "main",
}));
vi.mock("../config/legacy.default-agent-owner.js", () => ({
  retainLegacyDefaultAgentId: vi.fn(),
  tryGetLegacyDefaultAgentId: vi.fn(),
}));
vi.mock("../config/legacy.default-agent-roles.js", () => ({
  materializeLegacyDefaultAgentRoles: vi.fn(),
  resolveLegacyFirstAgentWorkspacePin: vi.fn(),
}));
vi.mock("../utils.js", async () => ({
  ...(await import("../infra/plain-object.js")),
  resolveUserPath: vi.fn(),
}));

const modelsPath = ["models", "providers", "example", "models"];
const modelPath = (index: number, ...tail: string[]) => [...modelsPath, String(index), ...tail];
const pathSegments = (path: string | string[]) =>
  typeof path === "string" ? path.split(".") : path;
const namedEntries = (...names: string[]) =>
  Object.fromEntries(names.map((name, i) => [String(i), { name }]));
const modelConfig = (rows: { id: string; name: string }[]) => ({
  models: { providers: { example: { models: rows } } },
});
const referenceRows = (edited: string, untouched: string) => [
  { id: "drop", name: "drop" },
  { id: "edited", name: edited },
  { id: "untouched", name: untouched },
];
const rows = referenceRows("${ALIAS}", "${OTHER_ALIAS}");
const resolvedRows = referenceRows("${TARGET}", "${OTHER_TARGET}");
function op(
  mutation: ConfigSetOperation["mutation"],
  path: string | string[],
  value?: unknown,
): ConfigSetOperation {
  // Each command input is independently parsed JSON, not a shared fixture object.
  const segments = pathSegments(path);
  return {
    mutation,
    setPath: segments,
    requestedPath: segments,
    value: structuredClone(value),
    inputMode: "json",
  };
}
const editModelName = (index: number, name: string) => op("set", modelPath(index, "name"), name);
const deleteModel = (index: number) => op("delete", modelPath(index));
function loadSnapshot(resolved: unknown, authored: unknown = resolved): void {
  state.snapshot = {
    path: "/test/openclaw.json",
    resolved: structuredClone(resolved),
    sourceConfig: structuredClone(resolved),
    sourceConfigBeforeMigrations: structuredClone(resolved),
    runtimeConfig: structuredClone(resolved),
    authoredConfig: structuredClone(authored),
  };
}
const run = (operations: ConfigSetOperation[], successMode: "set" | "patch" = "patch") =>
  runConfigOperations({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    operations,
    options: {},
    successMode,
  });

async function apply(
  resolved: unknown,
  operations: ConfigSetOperation[],
  authored: unknown = resolved,
) {
  loadSnapshot(resolved, authored);
  await run(operations);
  expect(state.prepare).toHaveBeenCalled();
  expect(state.replace).toHaveBeenCalledTimes(1);
  const prepared = state.prepare.mock.calls.find(([params]) => params.explicitSetPaths)?.[0];
  const replaced = state.replace.mock.calls[0]?.[0];
  if (!prepared || !replaced) {
    throw new Error("Expected captured preparation and persistence calls");
  }
  return {
    paths: prepared.explicitSetPaths as string[][],
    config: replaced.sourceConfig as OpenClawConfig,
    policyPaths: replaced.writeOptions.explicitSetPaths as string[][],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.prepare.mockImplementation(({ nextConfig, snapshot, explicitSetPaths }) => ({
    resolutionEnv: {},
    authoredConfig: restoreEnvVarRefsFromResolved(
      nextConfig,
      snapshot.authoredConfig,
      snapshot.sourceConfigBeforeMigrations,
      explicitSetPaths,
    ),
  }));
});

describe("ordered runner supplied intent after deletion", () => {
  it.each([0, 1])(
    "keeps merge intent only on surviving models after deleting index %s",
    async (deleted) => {
      const result = await apply(
        modelConfig(resolvedRows),
        [op("merge", modelsPath, [{ id: "edited", name: "${TARGET}" }]), deleteModel(deleted)],
        modelConfig(rows),
      );
      expect(result.config.models?.providers?.example?.models).toEqual([
        deleted === 0 ? { id: "edited", name: "${TARGET}" } : { id: "drop", name: "drop" },
        { id: "untouched", name: "${OTHER_ALIAS}" },
      ]);
      expect(result.paths).toEqual(deleted === 0 ? [modelPath(0, "id"), modelPath(0, "name")] : []);
      expect(result.policyPaths).toEqual([modelsPath]);
    },
  );

  it.each<[string, unknown, ConfigSetOperation[], (string | string[])[]]>([
    [
      "successive splices",
      modelConfig(["a", "b", "c", "d"].map((id) => ({ id, name: id }))),
      [editModelName(3, "edited"), deleteModel(1), deleteModel(0)],
      [modelPath(1, "name")],
    ],
    [
      "earlier indices and unrelated arrays",
      { ...modelConfig(resolvedRows), other: [{ name: "first" }, { name: "second" }] },
      [editModelName(0, "edited"), op("set", "other.1.name", "other edited"), deleteModel(2)],
      [modelPath(0, "name"), "other.1.name"],
    ],
    [
      "ancestor replacement",
      modelConfig(resolvedRows),
      [op("replace", modelsPath, resolvedRows), deleteModel(0)],
      [modelsPath],
    ],
    [
      "numeric object keys",
      { channels: { custom: { accounts: namedEntries("zero", "one") } } },
      [
        op("set", "channels.custom.accounts.0.name", "removed"),
        op("set", "channels.custom.accounts.1.name", "survivor"),
        op("delete", "channels.custom.accounts.0"),
      ],
      ["channels.custom.accounts.1.name"],
    ],
    [
      "nested array below a canonical agent ID",
      { agents: { entries: { "1": { tools: { allow: ["first", "second", "third"] } } } } },
      [
        op("set", "agents.list.0.tools.allow.2", "edited"),
        op("delete", "agents.list.0.tools.allow.0"),
      ],
      ["agents.entries.1.tools.allow.1"],
    ],
    [
      "recreated item",
      modelConfig(["a", "b", "c"].map((id) => ({ id, name: id }))),
      [
        editModelName(1, "removed"),
        deleteModel(1),
        op("replace", modelPath(1), { id: "fresh", name: "fresh" }),
      ],
      [modelPath(1)],
    ],
    [
      "missing deletion",
      modelConfig(resolvedRows),
      [editModelName(1, "edited"), deleteModel(8)],
      [modelPath(1, "name")],
    ],
  ])("preserves supplied intent for %s", async (_name, config, operations, paths) => {
    expect((await apply(config, operations)).paths).toEqual(paths.map(pathSegments));
  });

  it("drops deleted canonical agent intent without moving surviving IDs", async () => {
    const result = await apply(
      { agents: { ownership: "explicit", entries: namedEntries("zero", "one", "two") } },
      [
        op("set", "agents.list.0.name", "removed"),
        op("set", "agents.list.1.name", "survivor"),
        op("delete", "agents.list.0"),
      ],
    );
    expect(result.paths).toEqual([["agents", "entries", "1", "name"]]);
    expect(result.config.agents?.entries).toEqual({
      "1": { name: "survivor" },
      "2": { name: "two" },
    });
  });
});

// Advice must name registered flags: config patch has --replace-path, not --merge/--replace.
it.each([
  ["patch", "Use --replace-path models.providers.example.models to replace intentionally."],
  ["set", "Use --merge to merge by id or --replace to replace intentionally."],
] as const)(
  "refuses a %s model list replacement naming its own flags",
  async (successMode, advice) => {
    loadSnapshot(modelConfig(resolvedRows));
    await expect(
      run([op(undefined, modelsPath, [{ id: "edited", name: "${TARGET}" }])], successMode),
    ).rejects.toHaveProperty(
      "message",
      `Refusing to replace models.providers.example.models; it would remove existing entries: drop, untouched. ${advice}`,
    );
  },
);
