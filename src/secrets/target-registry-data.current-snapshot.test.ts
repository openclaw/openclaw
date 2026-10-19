/** Tests target-registry data built from the current runtime snapshot. */
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

const metadataMocks = vi.hoisted(() => ({
  listBundledPluginMetadata: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn<
    (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
      plugins: PluginManifestRecord[];
      manifestRegistry?: PluginManifestRegistry;
    }
  >(() => ({ plugins: [] })),
}));

vi.mock("../plugins/bundled-plugin-metadata.js", () => ({
  listBundledPluginMetadata: metadataMocks.listBundledPluginMetadata,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: metadataMocks.resolvePluginMetadataSnapshot,
}));

function writeChannelContract(
  pluginId: string,
  channelId = pluginId,
  ownership: "channelConfigs" | "channels" = "channels",
  targetId = `channels.${channelId}.token`,
) {
  const rootDir = makeTrackedTempDir("openclaw-target-registry-channel", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "secret-contract-api.cjs"),
    `module.exports = { secretTargetRegistryEntries: [${JSON.stringify({
      id: targetId,
      targetType: targetId,
      configFile: "openclaw.json",
      pathPattern: targetId,
      secretShape: "secret_input",
      expectedResolvedValue: "string",
      includeInPlan: true,
      includeInConfigure: true,
      includeInAudit: true,
    })}] };`,
    "utf8",
  );
  return createPluginManifestRecordFixture({
    id: pluginId,
    origin: "config",
    channels: ownership === "channels" ? [channelId] : [],
    channelConfigs: ownership === "channelConfigs" ? { [channelId]: { schema: {} } } : {},
    rootDir,
  });
}

function configPlugin(id: string, secretPath: string) {
  return createPluginManifestRecordFixture({
    id,
    origin: "config",
    configContracts: { secretInputs: { paths: [{ path: secretPath }] } },
  });
}

function usePlugins(plugins: PluginManifestRecord[], withRegistry = false) {
  metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({
    plugins,
    ...(withRegistry ? { manifestRegistry: { plugins, diagnostics: [] } } : {}),
  });
}

function expectedTarget(pluginId: string, suffix: string, segments = suffix) {
  const owner = pluginId.includes(".") ? `[${JSON.stringify(pluginId)}]` : `.${pluginId}`;
  return {
    path: `plugins.entries${owner}.config.${suffix}`,
    pathSegments: ["plugins", "entries", pluginId, "config", ...segments.split("/")],
  };
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function expectTargets(actual: unknown, targets: Array<{ path: string; pathSegments: string[] }>) {
  expect(actual).toEqual(
    expect.arrayContaining(targets.map((entry) => expect.objectContaining(entry))),
  );
}

function identityConfigs(token: (id: string) => unknown) {
  return {
    "foo.config.bar": { token: token("DOTTED_TOKEN") },
    foo: { bar: { config: { token: token("NESTED_TOKEN") } } },
    array: { accounts: [{ token: token("ARRAY_TOKEN") }] },
    record: {
      accounts: {
        "0": { token: token("RECORD_TOKEN") },
        "foo.bar": { token: token("RECORD_TOKEN") },
      },
    },
    "wildcard-array": { accounts: [{ token: token("WILDCARD_TOKEN") }] },
  };
}

describe("getSecretTargetRegistry metadata reuse", () => {
  beforeEach(() => {
    vi.resetModules();
    metadataMocks.listBundledPluginMetadata.mockReset();
    metadataMocks.listBundledPluginMetadata.mockImplementation(() => {
      throw new Error("source bundled metadata must not be scanned");
    });
    metadataMocks.resolvePluginMetadataSnapshot.mockClear();
    metadataMocks.resolvePluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  afterEach(() => {
    resetPluginCache();
    vi.unstubAllEnvs();
    cleanupTrackedTempDirs(tempDirs);
  });

  it.each(["bundled", "config"] as const)(
    "rejects a broken %s contract during source docs generation without changing runtime tolerance",
    async (origin) => {
      const healthy = writeChannelContract("healthy");
      const broken = writeChannelContract("broken");
      const missing = {
        ...broken,
        id: "missing",
        rootDir: makeTrackedTempDir("openclaw-target-registry-missing", tempDirs),
      };
      // A dependency failure can resemble the old missing-artifact message; it is not absence.
      const failure = "Unable to resolve bundled plugin public surface fixture dependency failed";
      fs.writeFileSync(
        path.join(broken.rootDir, "secret-contract-api.cjs"),
        `throw new Error(${JSON.stringify(failure)});`,
      );
      const records = [healthy, broken, missing].map((record) =>
        Object.assign({}, record, {
          origin,
          id: origin === "bundled" ? path.basename(record.rootDir) : record.id,
        }),
      );
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.dirname(healthy.rootDir));
      vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
      usePlugins(records);
      const { getSecretTargetRegistry } = await import("./target-registry-data.js");
      const { buildSecretRefCredentialMatrix } =
        await import("./credential-matrix.test-support.js");

      const runtimeIds = getSecretTargetRegistry({ config: {}, env: {} }).map((entry) => entry.id);
      expect(runtimeIds).toContain("channels.healthy.token");
      expect(runtimeIds).toContain("gateway.auth.token");
      expect(runtimeIds).not.toContain("channels.broken.token");
      expect(() => buildSecretRefCredentialMatrix()).toThrow(failure);

      usePlugins([records[0]!, records[2]!]);
      const matrixIds = buildSecretRefCredentialMatrix().entries.map((entry) => entry.id);
      expect(matrixIds).toContain("channels.healthy.token");
      expect(matrixIds).toContain("gateway.auth.token");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports a rejected contract boundary during source generation after runtime cached the rejection",
    async () => {
      const record = writeChannelContract("blocked");
      const outsideDir = makeTrackedTempDir("openclaw-contract-outside", tempDirs);
      fs.linkSync(
        path.join(record.rootDir, "secret-contract-api.cjs"),
        path.join(outsideDir, "linked-contract.cjs"),
      );
      usePlugins([record]);
      const { getSecretTargetRegistry } = await import("./target-registry-data.js");
      expect(
        getSecretTargetRegistry({ config: {}, env: {} }).map((entry) => entry.id),
      ).not.toContain("channels.blocked.token");
      expect(() => getSecretTargetRegistry({ sourceTree: true })).toThrow(
        "Unable to open channel secret contract for blocked",
      );
    },
  );

  it("registers secret targets for installed-origin plugins (#104320)", async () => {
    usePlugins([
      {
        ...configPlugin("exa", "webSearch.apiKey"),
        origin: "global",
        contracts: { webSearchProviders: ["exa"] },
        configUiHints: { "webSearch.apiKey": { sensitive: true } },
      },
    ]);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { isKnownSecretTargetId } = await import("./target-registry-query.js");

    const ids = getSecretTargetRegistry().map((entry) => entry.id);

    expect(ids).toContain("plugins.entries.exa.config.webSearch.apiKey");
    expect(isKnownSecretTargetId("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
  });

  it("preserves plugin, array, and record identity across discovery, setup, and apply", async () => {
    const rootDir = makeTrackedTempDir("openclaw-target-registry-plugin-identity", tempDirs);
    const pluginContracts = [
      { id: "foo.config.bar", secretPath: "token", refId: "DOTTED_TOKEN" },
      { id: "foo", secretPath: "bar.config.token", refId: "NESTED_TOKEN" },
      { id: "array", secretPath: "accounts[].token", refId: "ARRAY_TOKEN" },
      { id: "record", secretPath: "accounts.*.token", refId: "RECORD_TOKEN" },
      { id: "wildcard-array", secretPath: "accounts.*.token", refId: "WILDCARD_TOKEN" },
    ];
    const plugins = pluginContracts.map(({ id, secretPath }, index) => {
      const pluginRoot = path.join(rootDir, `plugin-${index}`);
      fs.mkdirSync(pluginRoot);
      fs.writeFileSync(
        path.join(pluginRoot, "index.js"),
        `export default { id: ${JSON.stringify(id)}, register() {} };`,
      );
      const manifest = {
        id,
        configSchema: { type: "object", additionalProperties: true },
        configContracts: { secretInputs: { paths: [{ path: secretPath }] } },
      };
      fs.writeFileSync(path.join(pluginRoot, "openclaw.plugin.json"), JSON.stringify(manifest));
      return createPluginManifestRecordFixture({
        ...manifest,
        origin: "config",
        rootDir: pluginRoot,
      });
    });
    usePlugins(plugins, true);

    const config = {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.rootDir) },
        entries: Object.fromEntries(
          Object.entries(identityConfigs((id) => `${id}-plaintext`)).map(([id, pluginConfig]) => [
            id,
            { enabled: true, config: pluginConfig },
          ]),
        ),
      },
    };
    const expectedTargets = [
      expectedTarget("foo.config.bar", "token"),
      expectedTarget("foo", "bar.config.token", "bar/config/token"),
      expectedTarget("array", "accounts[0].token", "accounts/0/token"),
      expectedTarget("record", 'accounts["0"].token', "accounts/0/token"),
      expectedTarget("record", 'accounts["foo.bar"].token', "accounts/foo.bar/token"),
      expectedTarget("wildcard-array", "accounts[0].token", "accounts/0/token"),
    ];
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const { discoverConfigSecretTargets } = await import("./target-registry-query.js");
    const { buildConfigureCandidatesForScope, buildSecretsConfigurePlan } =
      await import("./configure-plan.js");
    const { isSecretsApplyPlan, resolveValidatedPlanTarget } = await import("./plan.js");

    expect(getSecretTargetRegistry({ config, env: {} })).toEqual(
      expect.arrayContaining(
        pluginContracts.map(({ id, secretPath }) => {
          const pluginPath = id.includes(".") ? `[${JSON.stringify(id)}]` : `.${id}`;
          const pathPattern = `plugins.entries${pluginPath}.config.${secretPath}`;
          return expect.objectContaining({
            id: pathPattern,
            pathPattern,
            pathPatternSegments: ["plugins", "entries", id, "config", ...secretPath.split(".")],
          });
        }),
      ),
    );
    expectTargets(discoverConfigSecretTargets(config), expectedTargets);

    const candidates = buildConfigureCandidatesForScope({ config }).filter((candidate) =>
      candidate.path.startsWith("plugins.entries"),
    );
    expectTargets(candidates, expectedTargets);
    const plan = buildSecretsConfigurePlan({
      selectedTargets: new Map(
        candidates.map((candidate) => {
          const refId = pluginContracts.find(({ id }) => candidate.pathSegments[2] === id)!.refId;
          return [candidate.path, { ...candidate, ref: envRef(refId) }];
        }),
      ),
      providerChanges: { upserts: {}, deletes: [] },
    });
    expect(plan.targets).toHaveLength(expectedTargets.length);
    const arrayTarget = plan.targets.find((target) => target.pathSegments?.[2] === "array")!;
    const recordTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "record" && target.pathSegments[5] === "0",
    )!;
    const wildcardArrayTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "wildcard-array",
    )!;
    const dottedPluginTarget = plan.targets.find(
      (target) => target.pathSegments?.[2] === "foo.config.bar",
    )!;
    const quotedArrayPath = 'plugins.entries.array.config.accounts["0"].token';
    for (const [target, token] of [
      [arrayTarget, 0],
      [recordTarget, "0"],
    ] as const) {
      const legacy = { ...target, path: target.pathSegments!.join(".") };
      expect(resolveValidatedPlanTarget(target)?.pathTokens[5]).toBe(token);
      expect(resolveValidatedPlanTarget(legacy)?.pathTokens[5]).toBe(token);
      expect(
        resolveValidatedPlanTarget({ ...legacy, pathSegments: undefined })?.pathTokens[5],
      ).toBe(token);
    }
    expect(resolveValidatedPlanTarget(wildcardArrayTarget)?.pathTokens[5]).toBe(0);
    expect(Object.hasOwn(arrayTarget, "pathTokens")).toBe(false);
    expect(resolveValidatedPlanTarget({ ...arrayTarget, path: quotedArrayPath })).toBeNull();
    expect(
      resolveValidatedPlanTarget({
        ...dottedPluginTarget,
        path: dottedPluginTarget.pathSegments!.join("."),
      }),
    ).not.toBeNull();
    const forgedArrayPlan = {
      ...plan,
      generatedBy: "manual" as const,
      targets: [{ ...arrayTarget, path: quotedArrayPath }],
    };
    expect(isSecretsApplyPlan(forgedArrayPlan)).toBe(false);
    const { buildPluginSecretRefSetupPlan } = await import("./plugin-setup-plan.js");
    const setupPlan = buildPluginSecretRefSetupPlan({
      productName: "Fixture",
      providerAlias: "fixture",
      providerConfig: {
        source: "exec",
        pluginIntegration: { pluginId: "fixture", integrationId: "fixture" },
      },
      providerSecrets: [],
      configTargetSecrets: expectedTargets.map(({ path: targetPath }, index) => ({
        path: targetPath,
        secretId: `credentials/${index}`,
      })),
    });
    expectTargets(setupPlan.targets, expectedTargets);
    expect(isSecretsApplyPlan(plan)).toBe(true);

    const configPath = path.join(rootDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const { testing } = await import("./apply.js");
    const env = {
      OPENCLAW_STATE_DIR: rootDir,
      OPENCLAW_CONFIG_PATH: configPath,
      ...Object.fromEntries(pluginContracts.map(({ refId }) => [refId, "synthetic-secret"])),
    };
    await expect(testing.projectConfigForTest({ plan: forgedArrayPlan, env })).rejects.toThrow(
      /Invalid plan target path/,
    );
    const projected = await testing.projectConfigForTest({ plan, env });

    for (const [id, expected] of Object.entries(identityConfigs(envRef))) {
      expect(projected.plugins?.entries?.[id]?.config).toEqual(expected);
    }
  });

  it("builds config-scoped registries independently instead of reusing the singleton", async () => {
    metadataMocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { config?: { plugins?: { load?: { paths?: string[] } } } }) => {
        const pluginId = params?.config?.plugins?.load?.paths?.[0] ?? "missing";
        return { plugins: [configPlugin(pluginId, "credentials.token")] };
      },
    );
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");
    const firstConfig = { plugins: { load: { paths: ["first-plugin"] }, entries: {} } };
    const secondConfig = { plugins: { load: { paths: ["second-plugin"] }, entries: {} } };

    const firstIds = getSecretTargetRegistry({ config: firstConfig, env: {} }).map(
      (entry) => entry.id,
    );
    const secondIds = getSecretTargetRegistry({ config: secondConfig, env: {} }).map(
      (entry) => entry.id,
    );

    expect(firstIds).toContain("plugins.entries.first-plugin.config.credentials.token");
    expect(firstIds).not.toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).toContain("plugins.entries.second-plugin.config.credentials.token");
    expect(secondIds).not.toContain("plugins.entries.first-plugin.config.credentials.token");
  });

  it("loads channel contracts from every supported ownership field", async () => {
    const records = [
      writeChannelContract("custom-primary", "custom", "channels", "channels.custom.primaryToken"),
      writeChannelContract(
        "custom-secondary",
        "custom",
        "channelConfigs",
        "channels.custom.secondaryToken",
      ),
    ];
    usePlugins(records);
    const { getSecretTargetRegistry } = await import("./target-registry-data.js");

    const ids = getSecretTargetRegistry({
      config: { plugins: { load: { paths: records.map((record) => record.rootDir) } } },
      env: {},
    }).map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining(["channels.custom.primaryToken", "channels.custom.secondaryToken"]),
    );
  });
});
