import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import * as machineState from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
} from "./bundled-discovery-state.js";
import { resolvePluginDocumentExtractors } from "./document-extractors.runtime.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { resolvePluginWebContentExtractors } from "./web-content-extractors.runtime.js";
import {
  resolvePluginWebFetchProviders,
  resolveRuntimeWebFetchProviders,
} from "./web-fetch-providers.runtime.js";
import { resolveBundledWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "./web-search-providers.runtime.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearBundledDiscoveryModeMemo();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const PLUGIN_ID = "fixture-public-provider";
const artifacts = [
  ["web-search-contract-api.js", "WebSearchProvider"],
  ["web-fetch-contract-api.js", "WebFetchProvider"],
  ["web-fetch-provider.js", "WebFetchProvider"],
  ["document-extractor.js", "DocumentExtractor"],
  ["web-content-extractor.js", "WebContentExtractor"],
] as const;

function environment(marker: string) {
  const root = dirs.make("openclaw-public-artifact-env-");
  const bundledDir = path.join(root, "bundled");
  const pluginDir = path.join(bundledDir, PLUGIN_ID);
  const workspaceDir = path.join(root, "workspace");
  const evaluationsPath = path.join(root, "evaluations.log");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(evaluationsPath, "");
  const manifest = {
    id: PLUGIN_ID,
    enabledByDefault: true,
    configSchema: { type: "object", additionalProperties: false },
    contracts: {
      webSearchProviders: [PLUGIN_ID],
      webFetchProviders: [PLUGIN_ID],
      documentExtractors: [PLUGIN_ID],
      webContentExtractors: [PLUGIN_ID],
    },
  };
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ type: "commonjs", openclaw: { extensions: ["./index.js"] } }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    "throw new Error('Public artifact resolution must not activate the runtime entry');\n",
  );
  for (const [basename, suffix] of artifacts) {
    fs.writeFileSync(
      path.join(pluginDir, basename),
      `require('node:fs').appendFileSync(${JSON.stringify(evaluationsPath)}, ${JSON.stringify(`${basename}\n`)});
module.exports.createFixture${suffix} = () => ({
  id: ${JSON.stringify(PLUGIN_ID)}, label: ${JSON.stringify(marker)}, hint: '',
  envVars: [], placeholder: '', signupUrl: '', credentialPath: 'apiKey',
  getCredentialValue() {}, setCredentialValue() {}, createTool() { return null; },
  mimeTypes: ['application/pdf'], extract: async () => ({ text: ${JSON.stringify(marker)} }),
});\n`,
    );
  }
  return {
    env: {
      VITEST: "true",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    },
    workspaceDir,
    manifestRecords: [createPluginManifestRecordFixture({ ...manifest, rootDir: pluginDir })],
    evaluations: () => fs.readFileSync(evaluationsPath, "utf8").split("\n").filter(Boolean),
  };
}

function useProcessEnvironment(fixture: ReturnType<typeof environment>) {
  for (const [key, value] of Object.entries(fixture.env)) {
    vi.stubEnv(key, value);
  }
}

function resolution(fixture: ReturnType<typeof environment>, allow = [PLUGIN_ID]) {
  return {
    env: fixture.env,
    workspaceDir: fixture.workspaceDir,
    manifestRecords: fixture.manifestRecords,
    onlyPluginIds: [PLUGIN_ID],
    config: { plugins: { allow, entries: { [PLUGIN_ID]: { enabled: true } } } },
  };
}

type Resolution = ReturnType<typeof resolution>;
const setupResolvers = [
  {
    name: "web search setup",
    artifact: "web-search-contract-api.js",
    resolve: (params: Resolution) => resolvePluginWebSearchProviders({ ...params, mode: "setup" }),
  },
  {
    name: "web fetch setup",
    artifact: "web-fetch-contract-api.js",
    resolve: (params: Resolution) => resolvePluginWebFetchProviders({ ...params, mode: "setup" }),
  },
];

describe("public artifact environment ownership", () => {
  it.each(["missing", "nonbundled"] as const)(
    "does not substitute a stock provider for a %s prepared owner",
    async (kind) => {
      const fixture = environment("stock");
      useProcessEnvironment(fixture);
      await using cache = createPluginCache();
      withPluginCache(cache, () => {
        expect(
          resolveBundledWebSearchProvidersFromPublicArtifacts({
            ...resolution(fixture),
            manifestRecords:
              kind === "missing"
                ? []
                : fixture.manifestRecords.map((record) => ({
                    ...record,
                    origin: "global" as const,
                  })),
          }),
        ).toBeNull();
      });
      expect(fixture.evaluations()).toEqual([]);
    },
  );

  it.each([
    ...setupResolvers,
    {
      name: "web search runtime descriptors",
      artifact: "web-search-contract-api.js",
      resolve: resolveRuntimeWebSearchProviders,
    },
    {
      name: "web fetch runtime",
      artifact: "web-fetch-provider.js",
      resolve: resolveRuntimeWebFetchProviders,
    },
    {
      name: "document extractors",
      artifact: "document-extractor.js",
      resolve: resolvePluginDocumentExtractors,
    },
    {
      name: "web content extractors",
      artifact: "web-content-extractor.js",
      resolve: resolvePluginWebContentExtractors,
    },
  ])("loads and reuses each caller's artifact for $name", async ({ resolve, artifact }) => {
    const ambient = environment("ambient");
    const caller = environment("caller");
    useProcessEnvironment(ambient);
    await using cache = createPluginCache();
    withPluginCache(cache, () => {
      for (const [fixture, expected] of [
        [caller, "caller"],
        [ambient, "ambient"],
        [caller, "caller"],
      ] as const) {
        expect(resolve(resolution(fixture)).map((provider) => provider.label)).toEqual([expected]);
      }
    });
    expect(ambient.evaluations()).toEqual([artifact]);
    expect(caller.evaluations()).toEqual([artifact]);
  });

  describe.each(setupResolvers)("$name compatibility", ({ resolve }) => {
    it.each(["compat", "allowlist"] as const)(
      "uses the caller's %s policy instead of the opposite process policy",
      async (mode) => {
        const ambient = environment("ambient");
        const caller = environment("caller");
        useProcessEnvironment(ambient);
        writeConfigMachineState(
          "plugins.bundledDiscovery",
          mode === "compat" ? "allowlist" : "compat",
          { env: ambient.env },
        );
        writeConfigMachineState("plugins.bundledDiscovery", mode, { env: caller.env });
        clearBundledDiscoveryModeMemo();
        await using cache = createPluginCache();
        withPluginCache(cache, () => {
          expect(
            resolve(resolution(caller, ["another-plugin"])).map((entry) => entry.label),
          ).toEqual(mode === "compat" ? ["caller"] : []);
        });
      },
    );
  });

  it("reuses prepared discovery policy across repeated web setup calls without synchronous state reads", async () => {
    const fixture = environment("prepared");
    useProcessEnvironment(fixture);
    writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: fixture.env });
    clearBundledDiscoveryModeMemo();
    await closeOpenClawStateDatabaseAsync();
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      await prepareBundledDiscoveryMode(fixture.env);
      const reads = vi.spyOn(machineState, "readConfigMachineState");
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(
          resolvePluginWebSearchProviders({
            ...resolution(fixture, ["another-plugin"]),
            mode: "setup",
          }).map((provider) => provider.label),
        ).toEqual(["prepared"]);
      }
      expect(reads.mock.calls.filter(([key]) => key === "plugins.bundledDiscovery")).toHaveLength(
        0,
      );
    });
    expect(fixture.evaluations()).toEqual(["web-search-contract-api.js"]);
  });
});
