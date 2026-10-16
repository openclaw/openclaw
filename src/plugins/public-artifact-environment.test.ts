import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
function environment(marker: string) {
  const root = dirs.make("openclaw-public-artifact-env-");
  const bundledDir = path.join(root, "bundled");
  const pluginDir = path.join(bundledDir, PLUGIN_ID);
  const workspaceDir = path.join(root, "workspace");
  const evaluationsPath = path.join(root, "evaluations.log");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(evaluationsPath, "");
  const write = (file: string, body: string | object) =>
    fs.writeFileSync(
      path.join(pluginDir, file),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  const manifest = {
    id: PLUGIN_ID,
    enabledByDefault: true,
    configSchema: { type: "object", additionalProperties: false },
    contracts: Object.fromEntries(
      artifacts.map(([, type]) => [
        `${type.charAt(0).toLowerCase()}${type.slice(1)}s`,
        [PLUGIN_ID],
      ]),
    ),
  };
  write("openclaw.plugin.json", manifest);
  write("package.json", { type: "commonjs", openclaw: { extensions: ["./index.js"] } });
  write(
    "index.js",
    "throw new Error('Public artifact resolution must not activate the runtime entry');\n",
  );
  for (const [basename, suffix] of new Map(artifacts.map(([file, type]) => [file, type]))) {
    write(
      basename,
      `require('node:fs').appendFileSync(${JSON.stringify(evaluationsPath)}, ${JSON.stringify(`${basename}\n`)});
module.exports.createFixture${suffix} = () => ({
  id: ${JSON.stringify(PLUGIN_ID)}, label: ${JSON.stringify(marker)}, hint: '',
  envVars: [], placeholder: '', signupUrl: '', credentialPath: 'apiKey',
  getCredentialValue() {}, setCredentialValue() {}, createTool() { return null; },
  mimeTypes: ['application/pdf'], extract: async () => ({ text: ${JSON.stringify(marker)} }),
});\n`,
    );
  }
  const env = {
    VITEST: "true",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  };
  const manifestRecords = [createPluginManifestRecordFixture({ ...manifest, rootDir: pluginDir })];
  const params = (allow = [PLUGIN_ID]) => ({
    env,
    workspaceDir,
    manifestRecords,
    onlyPluginIds: [PLUGIN_ID],
    config: { plugins: { allow, entries: { [PLUGIN_ID]: { enabled: true } } } },
  });
  return {
    env,
    manifestRecords,
    params,
    evaluations: () => fs.readFileSync(evaluationsPath, "utf8").split("\n").filter(Boolean),
    labels: (resolve: (input: Resolution) => { label: string }[], allow?: string[]) =>
      resolve(params(allow)).map((entry) => entry.label),
    async run<T>(test: () => T) {
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      await using cache = createPluginCache();
      return await withPluginCache(cache, test);
    },
  };
}
type Resolution = Parameters<typeof resolveRuntimeWebSearchProviders>[0];
const artifacts = [
  [
    "web-search-contract-api.js",
    "WebSearchProvider",
    (params: Resolution) => resolvePluginWebSearchProviders({ ...params, mode: "setup" }),
  ],
  [
    "web-fetch-contract-api.js",
    "WebFetchProvider",
    (params: Resolution) => resolvePluginWebFetchProviders({ ...params, mode: "setup" }),
  ],
  ["web-search-contract-api.js", "WebSearchProvider", resolveRuntimeWebSearchProviders],
  ["web-fetch-provider.js", "WebFetchProvider", resolveRuntimeWebFetchProviders],
  ["document-extractor.js", "DocumentExtractor", resolvePluginDocumentExtractors],
  ["web-content-extractor.js", "WebContentExtractor", resolvePluginWebContentExtractors],
] as const;
const setupResolvers = artifacts.slice(0, 2);

it.each(["missing", "nonbundled"] as const)(
  "does not substitute a stock provider for a %s prepared owner",
  async (kind) => {
    const fixture = environment("stock");
    await fixture.run(() => {
      expect(
        resolveBundledWebSearchProvidersFromPublicArtifacts({
          ...fixture.params(),
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

it.each(artifacts)(
  "loads and reuses each caller's %s artifact [%#]",
  async (artifact, _type, resolve) => {
    const ambient = environment("ambient");
    const caller = environment("caller");
    await ambient.run(() => {
      for (const [fixture, expected] of [
        [caller, "caller"],
        [ambient, "ambient"],
        [caller, "caller"],
      ] as const) {
        expect(fixture.labels(resolve)).toEqual([expected]);
      }
    });
    expect(ambient.evaluations()).toEqual([artifact]);
    expect(caller.evaluations()).toEqual([artifact]);
  },
);

it.each(
  setupResolvers.flatMap(([artifact, , resolve]) =>
    (["compat", "allowlist"] as const).map((mode) => ({ artifact, resolve, mode })),
  ),
)(
  "$artifact uses the caller's $mode policy instead of the opposite process policy",
  async ({ mode, resolve }) => {
    const ambient = environment("ambient");
    const caller = environment("caller");
    await ambient.run(() => {
      writeConfigMachineState(
        "plugins.bundledDiscovery",
        mode === "compat" ? "allowlist" : "compat",
        { env: ambient.env },
      );
      writeConfigMachineState("plugins.bundledDiscovery", mode, { env: caller.env });
      clearBundledDiscoveryModeMemo();
      expect(caller.labels(resolve, ["another-plugin"])).toEqual(
        mode === "compat" ? ["caller"] : [],
      );
    });
  },
);

it("reuses prepared discovery policy across repeated web setup calls without synchronous state reads", async () => {
  const fixture = environment("prepared");
  await fixture.run(async () => {
    writeConfigMachineState("plugins.bundledDiscovery", "compat", { env: fixture.env });
    clearBundledDiscoveryModeMemo();
    await closeOpenClawStateDatabaseAsync();
    await prepareBundledDiscoveryMode(fixture.env);
    const reads = vi.spyOn(machineState, "readConfigMachineState");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(fixture.labels(artifacts[0][2], ["another-plugin"])).toEqual(["prepared"]);
    }
    expect(reads.mock.calls.filter(([key]) => key === "plugins.bundledDiscovery")).toHaveLength(0);
  });
  expect(fixture.evaluations()).toEqual(["web-search-contract-api.js"]);
});
