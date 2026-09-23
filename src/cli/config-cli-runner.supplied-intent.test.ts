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
async function apply(
  resolved: unknown,
  operations: ConfigSetOperation[],
  authored: unknown = resolved,
) {
  state.snapshot = {
    path: "/test/openclaw.json",
    resolved: structuredClone(resolved),
    sourceConfig: structuredClone(resolved),
    sourceConfigBeforeMigrations: structuredClone(resolved),
    runtimeConfig: structuredClone(resolved),
    authoredConfig: structuredClone(authored),
  };
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
  it("keeps a merge-by-id reference change on its surviving model after an earlier splice", async () => {
    const result = await apply(
      modelConfig(resolvedRows),
      [op("merge", modelsPath, [{ id: "edited", name: "${TARGET}" }]), op("delete", modelPath(0))],
      modelConfig(rows),
    );
    expect(result.config.models?.providers?.example?.models).toEqual([
      { id: "edited", name: "${TARGET}" },
      { id: "untouched", name: "${OTHER_ALIAS}" },
    ]);
    expect(result.paths).toEqual([modelPath(0, "id"), modelPath(0, "name")]);
    // Policy ownership remains at the parent merge path.
    expect(result.policyPaths).toEqual([modelsPath]);
  });

  it("removes deleted-item intent so it cannot attach to the next survivor", async () => {
    const result = await apply(
      modelConfig(resolvedRows),
      [op("merge", modelsPath, [{ id: "edited", name: "${TARGET}" }]), op("delete", modelPath(1))],
      modelConfig(rows),
    );
    expect(result.config.models?.providers?.example?.models).toEqual([
      { id: "drop", name: "drop" },
      { id: "untouched", name: "${OTHER_ALIAS}" },
    ]);
    expect(result.paths).toEqual([]);
  });

  it("rebases against the current index after each successive splice", async () => {
    const result = await apply(
      modelConfig([
        { id: "a", name: "a" },
        { id: "b", name: "b" },
        { id: "c", name: "c" },
        { id: "d", name: "d" },
      ]),
      [
        op("set", modelPath(3, "name"), "edited"),
        op("delete", modelPath(1)),
        op("delete", modelPath(0)),
      ],
    );
    expect(result.paths).toEqual([modelPath(1, "name")]);
  });

  it("leaves intent before a deletion and in unrelated arrays unchanged", async () => {
    const result = await apply(
      {
        ...modelConfig(resolvedRows),
        other: [{ name: "first" }, { name: "second" }],
      },
      [
        op("set", modelPath(0, "name"), "edited"),
        op("set", ["other", "1", "name"], "other edited"),
        op("delete", modelPath(2)),
      ],
    );
    expect(result.paths).toEqual([modelPath(0, "name"), ["other", "1", "name"]]);
  });

  it("retains ancestor replacement intent across a child splice", async () => {
    const result = await apply(modelConfig(resolvedRows), [
      op("replace", modelsPath, resolvedRows),
      op("delete", modelPath(0)),
    ]);
    expect(result.paths).toEqual([modelsPath]);
  });

  it("does not reindex numeric object keys and removes only the deleted key's intent", async () => {
    const result = await apply(
      {
        channels: {
          custom: {
            accounts: {
              "0": { name: "zero" },
              "1": { name: "one" },
            },
          },
        },
      },
      [
        op("set", ["channels", "custom", "accounts", "0", "name"], "removed"),
        op("set", ["channels", "custom", "accounts", "1", "name"], "survivor"),
        op("delete", ["channels", "custom", "accounts", "0"]),
      ],
    );
    expect(result.paths).toEqual([["channels", "custom", "accounts", "1", "name"]]);
  });

  it("does not shift canonical numeric agent IDs after a legacy roster splice", async () => {
    const result = await apply(
      {
        agents: {
          list: [
            { id: "0", name: "zero" },
            { id: "1", name: "one" },
            { id: "2", name: "two" },
          ],
        },
      },
      [op("set", ["agents", "list", "1", "name"], "edited"), op("delete", ["agents", "list", "0"])],
    );
    expect(result.paths).toEqual([["agents", "entries", "1", "name"]]);
    expect(result.config.agents?.entries).toEqual({
      "1": { name: "edited" },
      "2": { name: "two" },
    });
  });

  it("drops deleted canonical agent intent without moving surviving IDs", async () => {
    const result = await apply(
      {
        agents: {
          list: [
            { id: "0", name: "zero" },
            { id: "1", name: "one" },
          ],
        },
      },
      [
        op("set", ["agents", "list", "0", "name"], "removed"),
        op("set", ["agents", "list", "1", "name"], "survivor"),
        op("delete", ["agents", "list", "0"]),
      ],
    );
    expect(result.paths).toEqual([["agents", "entries", "1", "name"]]);
  });

  it("rebases a nested array below a canonical agent ID", async () => {
    const result = await apply(
      { agents: { list: [{ id: "1", tools: { allow: ["first", "second", "third"] } }] } },
      [
        op("set", ["agents", "list", "0", "tools", "allow", "2"], "edited"),
        op("delete", ["agents", "list", "0", "tools", "allow", "0"]),
      ],
    );
    expect(result.paths).toEqual([["agents", "entries", "1", "tools", "allow", "1"]]);
  });

  it("records fresh intent after deleting and recreating an item", async () => {
    const result = await apply(
      modelConfig([
        { id: "a", name: "a" },
        { id: "b", name: "b" },
        { id: "c", name: "c" },
      ]),
      [
        op("set", modelPath(1, "name"), "removed"),
        op("delete", modelPath(1)),
        op("replace", modelPath(1), { id: "fresh", name: "fresh" }),
      ],
    );
    expect(result.paths).toEqual([modelPath(1)]);
  });

  it("does not rebase intent for a missing array deletion", async () => {
    const result = await apply(modelConfig(resolvedRows), [
      op("set", modelPath(1, "name"), "edited"),
      op("delete", modelPath(8)),
    ]);
    expect(result.paths).toEqual([modelPath(1, "name")]);
  });
});

describe("ordered writer policy after deletion", () => {
  it("keeps final writer restoration on the shifted explicit leaf", async () => {
    const authored = modelConfig(rows);
    const resolved = modelConfig(resolvedRows);
    const result = await apply(
      resolved,
      [op("set", modelPath(1, "name"), "${TARGET}"), op("delete", modelPath(0))],
      authored,
    );
    expect(result.policyPaths).toEqual([modelPath(0, "name")]);
    expect(
      restoreEnvVarRefsFromResolved(result.config, authored, resolved, result.policyPaths),
    ).toEqual(
      modelConfig([
        { id: "edited", name: "${TARGET}" },
        { id: "untouched", name: "${OTHER_ALIAS}" },
      ]),
    );
  });

  it("removes deleted explicit leaf policy without authorizing its survivor", async () => {
    const result = await apply(
      modelConfig(resolvedRows),
      [op("set", modelPath(1, "name"), "${TARGET}"), op("delete", modelPath(1))],
      modelConfig(rows),
    );
    expect(result.policyPaths).toBeUndefined();
  });
});
