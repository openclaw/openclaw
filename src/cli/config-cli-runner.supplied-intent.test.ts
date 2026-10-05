import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreEnvVarRefsFromResolved } from "../config/env-preserve.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConfigSetOperation } from "./config-cli-input.js";
import { runConfigOperations } from "./config-cli-runner.js";

// Exercise the real ordered runner, path mutators, roster projection and reference
// restorer. Snapshot loading, schema/policy checks and persistence are boundaries;
// this suite does not claim writer/topology or registered CLI acceptance.
const state = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  prepare: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("../config/config.js", () => ({ replaceConfigFile: state.replace }));
vi.mock("./config-cli-validation.js", () => ({
  loadValidConfigForWrite: async () => ({ snapshot: state.snapshot, writeOptions: {} }),
  validateConfigMutation: async () => ({ kind: "write" }),
  assertStrictConfigForMutation: vi.fn(),
}));
vi.mock("../config/io.write-prepare.js", () => ({
  prepareConfigWriteValues: state.prepare,
}));
vi.mock("../config/io.write-topology.js", () => ({
  prepareConfigWriteTopology: () => {
    throw new Error("Unexpected dry-run topology");
  },
}));
vi.mock("../config/config-path-mutation.js", () => ({
  resolveManagedUnsetPathsForWrite: () => {
    throw new Error("Unexpected dry-run unsets");
  },
}));
vi.mock("../config/io.meta.js", () => ({ AUTO_MANAGED_CONFIG_META_PATHS: [] }));
vi.mock("../config/io.read-helpers.js", () => ({
  coerceConfig: (value: unknown) => value,
}));
vi.mock("../config/paths.js", () => ({
  resolveConfigPath: () => "/test/openclaw.json",
  resolveStateDir: vi.fn(),
}));
vi.mock("../config/redact-snapshot.js", () => ({
  REDACTED_SENTINEL: "__OPENCLAW_REDACTED__",
  restoreRedactedValues: () => {
    throw new Error("Unexpected redacted input");
  },
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
vi.mock("./config-cli-input.js", () => ({ formatPluginInstallConfigSetError: vi.fn() }));
vi.mock("./config-cli-model-normalization.js", () => ({
  normalizeConfigMutationModelRefs: (value: unknown) => value,
  normalizeConfigMutationExplicitSetPath: (path: string[]) => path,
}));
vi.mock("./config-set-dryrun.js", () => ({
  ConfigSetDryRunValidationError: class extends Error {},
  printConfigDryRunResult: vi.fn(),
}));
vi.mock("./one-shot-exit.js", () => ({ exitCliAfterOutput: vi.fn() }));
vi.mock("./command-format.js", () => ({ formatCliCommand: (s: string) => s }));
// This public predecessor keeps roster functions in agent-scope-config.
// Leave that implementation real and isolate only its workspace services.
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
const modelConfig = (rows: { id: string; name: string }[]) => ({
  models: { providers: { example: { models: rows } } },
});
const rows = [
  { id: "drop", name: "drop" },
  { id: "edited", name: "${ALIAS}" },
  { id: "untouched", name: "${OTHER_ALIAS}" },
];
const resolvedRows = [
  { id: "drop", name: "drop" },
  { id: "edited", name: "${TARGET}" },
  { id: "untouched", name: "${OTHER_TARGET}" },
];
function op(
  mutation: ConfigSetOperation["mutation"],
  path: string[],
  value?: unknown,
): ConfigSetOperation {
  // Each command input is independently parsed JSON, not a shared fixture object.
  return {
    mutation,
    setPath: path,
    requestedPath: path,
    value: structuredClone(value),
    inputMode: "json",
  };
}
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

async function apply(
  resolved: unknown,
  operations: ConfigSetOperation[],
  authored: unknown = resolved,
) {
  loadSnapshot(resolved, authored);
  await runConfigOperations({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    operations,
    options: {},
    successMode: "patch",
  });
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
        [
          op("merge", modelsPath, [{ id: "edited", name: "${TARGET}" }]),
          op("delete", modelPath(deleted)),
        ],
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

  it.each([
    {
      name: "successive splices",
      config: modelConfig(["a", "b", "c", "d"].map((id) => ({ id, name: id }))),
      operations: [
        op("set", modelPath(3, "name"), "edited"),
        op("delete", modelPath(1)),
        op("delete", modelPath(0)),
      ],
      paths: [modelPath(1, "name")],
    },
    {
      name: "earlier indices and unrelated arrays",
      config: { ...modelConfig(resolvedRows), other: [{ name: "first" }, { name: "second" }] },
      operations: [
        op("set", modelPath(0, "name"), "edited"),
        op("set", ["other", "1", "name"], "other edited"),
        op("delete", modelPath(2)),
      ],
      paths: [modelPath(0, "name"), ["other", "1", "name"]],
    },
    {
      name: "ancestor replacement",
      config: modelConfig(resolvedRows),
      operations: [op("replace", modelsPath, resolvedRows), op("delete", modelPath(0))],
      paths: [modelsPath],
    },
    {
      name: "numeric object keys",
      config: {
        channels: { custom: { accounts: { "0": { name: "zero" }, "1": { name: "one" } } } },
      },
      operations: [
        op("set", ["channels", "custom", "accounts", "0", "name"], "removed"),
        op("set", ["channels", "custom", "accounts", "1", "name"], "survivor"),
        op("delete", ["channels", "custom", "accounts", "0"]),
      ],
      paths: [["channels", "custom", "accounts", "1", "name"]],
    },
    {
      name: "nested array below a canonical agent ID",
      config: { agents: { entries: { "1": { tools: { allow: ["first", "second", "third"] } } } } },
      operations: [
        op("set", ["agents", "list", "0", "tools", "allow", "2"], "edited"),
        op("delete", ["agents", "list", "0", "tools", "allow", "0"]),
      ],
      paths: [["agents", "entries", "1", "tools", "allow", "1"]],
    },
    {
      name: "recreated item",
      config: modelConfig(["a", "b", "c"].map((id) => ({ id, name: id }))),
      operations: [
        op("set", modelPath(1, "name"), "removed"),
        op("delete", modelPath(1)),
        op("replace", modelPath(1), { id: "fresh", name: "fresh" }),
      ],
      paths: [modelPath(1)],
    },
    {
      name: "missing deletion",
      config: modelConfig(resolvedRows),
      operations: [op("set", modelPath(1, "name"), "edited"), op("delete", modelPath(8))],
      paths: [modelPath(1, "name")],
    },
  ])("preserves supplied intent for $name", async ({ config, operations, paths }) => {
    expect((await apply(config, operations)).paths).toEqual(paths);
  });

  it("drops deleted canonical agent intent without moving surviving IDs", async () => {
    const result = await apply(
      {
        agents: {
          ownership: "explicit",
          entries: {
            "0": { name: "zero" },
            "1": { name: "one" },
            "2": { name: "two" },
          },
        },
      },
      [
        op("set", ["agents", "list", "0", "name"], "removed"),
        op("set", ["agents", "list", "1", "name"], "survivor"),
        op("delete", ["agents", "list", "0"]),
      ],
    );
    expect(result.paths).toEqual([["agents", "entries", "1", "name"]]);
    expect(result.config.agents?.entries).toEqual({
      "1": { name: "survivor" },
      "2": { name: "two" },
    });
  });
});

describe("replacement guard advice per subcommand", () => {
  async function refusal(successMode: "set" | "patch"): Promise<string> {
    loadSnapshot(modelConfig(resolvedRows));
    try {
      await runConfigOperations({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        operations: [op(undefined, modelsPath, [{ id: "edited", name: "${TARGET}" }])],
        options: {},
        successMode,
      });
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected the replacement guard to refuse");
  }

  // The advice has to name flags the running subcommand registers: `config patch` accepts
  // neither --merge nor --replace, only --replace-path.
  it.each([
    {
      successMode: "patch" as const,
      advice: "Use --replace-path models.providers.example.models to replace intentionally.",
    },
    {
      successMode: "set" as const,
      advice: "Use --merge to merge by id or --replace to replace intentionally.",
    },
  ])(
    "refuses a $successMode model list replacement naming its own flags",
    async ({ successMode, advice }) => {
      expect(await refusal(successMode)).toBe(
        `Refusing to replace models.providers.example.models; it would remove existing entries: drop, untouched. ${advice}`,
      );
    },
  );
});
