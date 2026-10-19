/** Tests plugin-specific runtime config secret collectors. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestSecretInputPath } from "../plugins/manifest-types.js";
import type { PluginOrigin } from "../plugins/types.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import { createResolverContext, type ResolverContext } from "./runtime-shared.js";

const { loadPluginManifestRegistryForPluginRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistryMock: vi.fn(),
}));

vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginManifestRegistry: () => loadPluginManifestRegistryForPluginRegistryMock(),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistryForPluginRegistryMock,
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  findBundledPluginMetadataById: () => undefined,
  listBundledPluginMetadata: () => [],
}));

function asConfig(value: unknown): OpenClawConfig {
  return { agents: { entries: { main: {} } }, ...(value as OpenClawConfig) };
}

function makeContext(
  sourceConfig: OpenClawConfig,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
): ResolverContext {
  return createResolverContext({
    sourceConfig,
    env: { OPENCLAW_STATE_DIR: process.env.OPENCLAW_TEST_HOME },
    manifestRegistry,
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function contractRecord(id: string, paths: PluginManifestSecretInputPath[]) {
  return { id, origin: "config" as const, configContracts: { secretInputs: { paths } } };
}

function createPluginConfig(
  pluginId: string,
  config: Record<string, unknown>,
  entry: Record<string, unknown> = { enabled: true },
  plugins: Record<string, unknown> = {},
): OpenClawConfig {
  return asConfig({ plugins: { ...plugins, entries: { [pluginId]: { ...entry, config } } } });
}

function collectAssignments(
  config: OpenClawConfig,
  origins?: Array<[string, PluginOrigin]>,
  context = makeContext(config),
): ResolverContext {
  collectPluginConfigAssignments({
    config,
    defaults: undefined,
    context,
    loadablePluginOrigins: origins && new Map(origins),
  });
  return context;
}

function expectInactiveAcpxConfig(params: {
  plugins?: Record<string, unknown>;
  entry?: Record<string, unknown>;
}): void {
  const config = createPluginConfig(
    "acpx",
    { mcpServers: { s1: { command: "node", env: { K: envRef("K") } } } },
    params.entry ?? {},
    params.plugins,
  );
  const context = collectAssignments(config, [["acpx", "bundled"]]);
  expect(context.assignments).toHaveLength(0);
  expect(context.warnings.map((warning) => warning.code)).toContain(
    "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
  );
}

describe("collectPluginConfigAssignments", () => {
  beforeEach(() => {
    loadPluginManifestRegistryForPluginRegistryMock.mockReset();
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "acpx",
          origin: "bundled",
          providers: [],
          legacyPluginIds: [],
          configContracts: {
            secretInputs: {
              bundledDefaultEnabled: false,
              paths: [{ path: "mcpServers.*.env.*", expected: "string" }],
            },
          },
        },
        { id: "other", origin: "config", providers: [], legacyPluginIds: [] },
      ],
      diagnostics: [],
    });
  });

  it("does not load plugin metadata for empty entries", () => {
    const context = collectAssignments(asConfig({ plugins: { entries: {} } }));
    expect(context.assignments).toEqual([]);
    expect(loadPluginManifestRegistryForPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("keeps dotted plugin identities and plugin-local route paths distinct", () => {
    const pluginIds = ["foo.config.bar", "foo"] as const;
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: pluginIds.map((id) =>
        contractRecord(id, [
          { path: id === "foo" ? "bar.config.token" : "token", ownerKind: "route" },
        ]),
      ),
      diagnostics: [],
    });

    const context = collectAssignments(
      asConfig({
        plugins: {
          entries: {
            "foo.config.bar": { enabled: true, config: { token: envRef("DOTTED_TOKEN") } },
            foo: { enabled: true, config: { bar: { config: { token: envRef("NESTED_TOKEN") } } } },
          },
        },
      }),
      pluginIds.map((id) => [id, "config"]),
    );

    expect(context.assignments).toMatchObject([
      {
        path: 'plugins.entries["foo.config.bar"].config.token',
        ownerKind: "route",
        ownerId: 'plugins.entries["foo.config.bar"].config.token',
        ref: { id: "DOTTED_TOKEN" },
      },
      {
        path: "plugins.entries.foo.config.bar.config.token",
        ownerKind: "route",
        ownerId: "plugins.entries.foo.config.bar.config.token",
        ref: { id: "NESTED_TOKEN" },
      },
    ]);
    expect(new Set(context.assignments.map(({ ownerId }) => ownerId)).size).toBe(2);
  });

  it("collects and applies dotted wildcard keys separately from nested record keys", () => {
    loadPluginManifestRegistryForPluginRegistryMock.mockReturnValue({
      plugins: [contractRecord("distinct-keys", [{ path: "*.token" }, { path: "*.*.token" }])],
      diagnostics: [],
    });
    const config = createPluginConfig("distinct-keys", {
      "alpha.beta": { token: envRef("DOTTED_TOKEN") },
      alpha: { beta: { token: envRef("NESTED_TOKEN") } },
    });
    const context = collectAssignments(config, [["distinct-keys", "config"]]);

    expect(context.assignments).toMatchObject([
      {
        path: 'plugins.entries.distinct-keys.config["alpha.beta"].token',
        ref: { id: "DOTTED_TOKEN" },
      },
      {
        path: "plugins.entries.distinct-keys.config.alpha.beta.token",
        ref: { id: "NESTED_TOKEN" },
      },
    ]);
    context.assignments[0]?.apply("resolved-dotted");
    context.assignments[1]?.apply("resolved-nested");
    expect(config.plugins?.entries?.["distinct-keys"]?.config).toMatchObject({
      "alpha.beta": { token: "resolved-dotted" },
      alpha: { beta: { token: "resolved-nested" } },
    });
  });

  it("collects from a supplied manifest registry without cold registry loading", () => {
    const config = createPluginConfig("prepared-plugin", {
      credentials: { token: envRef("PREPARED_TOKEN") },
    });
    const context = makeContext(config, {
      plugins: [
        contractRecord("prepared-plugin", [
          { path: "credentials.token", expected: "string" },
        ]) as never,
      ],
    });

    collectAssignments(config, [["prepared-plugin", "config"]], context);

    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "plugins.entries.prepared-plugin.config.credentials.token",
    ]);
    expect(loadPluginManifestRegistryForPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("collects across multiple acpx servers only", () => {
    const config = createPluginConfig("acpx", {
      mcpServers: {
        s1: { command: "a", env: { K1: envRef("K1") } },
        s2: { command: "b", env: { K2: envRef("K2"), K3: envRef("K3") } },
      },
    });
    config.plugins!.entries!.other = {
      enabled: true,
      config: { mcpServers: { s3: { command: "c", env: { K4: envRef("K4") } } } },
    };
    const context = collectAssignments(config, [
      ["acpx", "bundled"],
      ["other", "config"],
    ]);

    expect(context.assignments.map(({ path }) => path).toSorted()).toEqual([
      "plugins.entries.acpx.config.mcpServers.s1.env.K1",
      "plugins.entries.acpx.config.mcpServers.s2.env.K2",
      "plugins.entries.acpx.config.mcpServers.s2.env.K3",
    ]);
  });

  it("skips assignments when entry.enabled is false", () => {
    expectInactiveAcpxConfig({ entry: { enabled: false } });
  });

  it("treats bundled acpx SecretRef surfaces as inactive until enabled", () => {
    expectInactiveAcpxConfig({ plugins: { enabled: true } });
  });

  it("collects inline env-template refs while leaving normal strings literal", () => {
    const config = createPluginConfig("acpx", {
      mcpServers: {
        s1: {
          command: "node",
          env: { INLINE: "${INLINE_KEY}", SECOND: "${SECOND_KEY}", LITERAL: "hello" },
        },
      },
    });
    const context = collectAssignments(config, [["acpx", "bundled"]]);
    expect(context.assignments.map(({ path }) => path)).toEqual([
      "plugins.entries.acpx.config.mcpServers.s1.env.INLINE",
      "plugins.entries.acpx.config.mcpServers.s1.env.SECOND",
    ]);
  });

  it("skips stale acpx entries not in loadablePluginOrigins", () => {
    const config = createPluginConfig("acpx", {
      mcpServers: { s1: { command: "node", env: { K1: envRef("K1") } } },
    });
    const context = collectAssignments(config, []);

    expect(context.assignments).toHaveLength(0);
    expect(
      context.warnings.some(
        (w) =>
          w.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
          w.path === "plugins.entries.acpx.config.mcpServers.s1.env.K1",
      ),
    ).toBe(true);
  });
});
