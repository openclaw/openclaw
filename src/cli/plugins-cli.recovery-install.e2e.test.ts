import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  readPersistedInstalledPluginIndexInstallRecordsAsync,
} from "../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { packPlugins, startStaticRegistry } from "../plugins/test-helpers/npm-registry-fixtures.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  startClawHubPackageFixture,
  type ClawHubFixtureOptions,
} from "./clawhub-package.test-support.js";

const PACKAGE = "@openclaw/brave-plugin";
const VERSION = "1.0.0";
const PLUGIN = "brave";
const PAYLOAD = "export default function register() {}\n";
const readText = (file: string) => fs.readFile(file, "utf8");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function startClawHubFixture(
  packageDir: string,
  options: Partial<ClawHubFixtureOptions> = {},
) {
  const files: Record<string, Buffer> = {};
  for (const file of ["package.json", "openclaw.plugin.json", "dist/index.js"]) {
    files[file] = await fs.readFile(path.join(packageDir, file));
  }
  return startClawHubPackageFixture({
    name: PACKAGE,
    id: PLUGIN,
    version: VERSION,
    files,
    ...options,
  });
}

async function readRecords(stateDir: string) {
  // The CLI writes in another process; observe its committed ledger, not this process's prior read.
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const records = await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir });
  await closeOpenClawStateDatabaseAsync();
  return records;
}

type Scenario = {
  spec: string;
  source: string | null;
  valid?: boolean;
  unbundled?: boolean;
  repeat?: boolean;
  error?: string;
  downloaded?: boolean;
  options?: Partial<ClawHubFixtureOptions>;
};
function remoteScenario(options: Partial<ClawHubFixtureOptions> = {}, error?: string): Scenario {
  return {
    spec: `clawhub:${PACKAGE}@${VERSION}`,
    source: error ? null : "clawhub",
    valid: true,
    options,
    error,
  };
}
const scenarios: Scenario[] = [
  { spec: `${PACKAGE}@${VERSION}`, source: null },
  { spec: `clawhub:${PACKAGE}@${VERSION}`, source: null },
  { spec: `npm:${PACKAGE}@${VERSION}`, source: "npm" },
  { spec: PLUGIN, source: "path" },
  { spec: PLUGIN, source: "npm", unbundled: true },
  { ...remoteScenario(), spec: `${PACKAGE}@${VERSION}`, repeat: true },
  remoteScenario({ telemetryStatus: 503 }),
  remoteScenario(
    { packageCompatibility: { pluginApiRange: ">=9999.0.0" }, artifactCompatibility: null },
    "requires plugin API >=9999.0.0",
  ),
  remoteScenario(
    { artifactCompatibility: { minGatewayVersion: "9999.0.0" } },
    "requires OpenClaw >=9999.0.0",
  ),
  {
    ...remoteScenario({ artifactSha256: "0".repeat(64) }, "ClawHub archive integrity mismatch"),
    downloaded: true,
  },
];

async function verifyInstalls(cases: Scenario[]) {
  const root = tempDirs.make("openclaw-recovery-install-e2e-");
  const catalogRequestsPath = path.join(root, "catalog-requests.jsonl");
  const offlineCatalogBootstrap = path.join(root, "offline-catalog.mjs");
  // Exercise the shipped official fallback catalog without an external feed dependency.
  // Only transport is replaced: catalog identity and install selection remain production code.
  await fs.writeFile(
    offlineCatalogBootstrap,
    `
    import { appendFileSync } from "node:fs";
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.href === "https://clawhub.ai/v1/feeds/plugins") {
        appendFileSync(${JSON.stringify(catalogRequestsPath)}, JSON.stringify(url.href) + "\\n");
        throw new Error("Synthetic hosted catalog transport outage");
      }
      if (url.hostname !== "127.0.0.1") {
        throw new Error("Unexpected non-loopback fixture request: " + url.href);
      }
      return fetch(input, init);
    };
    // fetch-guard preserves test transports instead of replacing them with its pinned dispatcher.
    globalThis.fetch.mock = {};
  `,
  );
  const npmrc = path.join(root, "npmrc");
  const globalNpmrc = path.join(root, "global.npmrc");
  await Promise.all([fs.writeFile(npmrc, ""), fs.writeFile(globalNpmrc, "")]);
  for (const name of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) {
    vi.stubEnv(name, npmrc);
  }
  for (const name of ["NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"]) {
    vi.stubEnv(name, globalNpmrc);
  }
  const versions = await packPlugins(root, [
    {
      packageName: PACKAGE,
      pluginId: PLUGIN,
      version: VERSION,
      indexJs: PAYLOAD,
      manifest: {
        channels: [PLUGIN],
        channelConfigs: { [PLUGIN]: { schema: { type: "object" } } },
      },
      openclaw: {
        extensions: ["./dist/index.js"],
        install: { allowInvalidConfigRecovery: true },
      },
    },
  ]);
  const bundledDir = path.join(root, "bundled");
  const packageDir = path.join(bundledDir, PLUGIN);
  await fs.mkdir(bundledDir);
  await fs.rename(path.join(root, `package-${PACKAGE}-${VERSION}`), packageDir);
  const npmServers: Server[] = [];
  const npmUrl = await startStaticRegistry(
    [{ packageName: PACKAGE, latest: VERSION, versions }],
    npmServers,
  );
  const npmRequests: string[] = [];
  npmServers[0]!.on("request", (request) => npmRequests.push(`${request.method} ${request.url}`));
  const clawhubs: Awaited<ReturnType<typeof startClawHubFixture>>[] = [];

  try {
    for (const [index, scenario] of cases.entries()) {
      const clawhub = await startClawHubFixture(packageDir, scenario.options);
      clawhubs.push(clawhub);
      const stateDir = path.join(root, `state-${index}`);
      const oldPluginPath = path.join(stateDir, "previous-plugin");
      const configPath = path.join(stateDir, "openclaw.json");
      const config: OpenClawConfig = scenario.valid
        ? {}
        : {
            channels: { [PLUGIN]: { fixtureToken: 123 } },
            plugins: {
              entries: { [PLUGIN]: { enabled: false, config: { marker: "preserve" } } },
            },
          };
      await fs.mkdir(stateDir);
      const originalConfig = `${JSON.stringify(config, null, 2)}\n`;
      await fs.writeFile(configPath, originalConfig);
      await fs.cp(packageDir, oldPluginPath, { recursive: true });
      const oldManifestPath = path.join(oldPluginPath, "openclaw.plugin.json");
      const oldManifest = JSON.parse(await fs.readFile(oldManifestPath, "utf8"));
      if (!scenario.valid) {
        oldManifest.channelConfigs[PLUGIN].schema = {
          type: "object",
          properties: { fixtureToken: { type: "string" } },
        };
      }
      await fs.writeFile(oldManifestPath, JSON.stringify(oldManifest));
      const originalRecord = {
        source: "path" as const,
        sourcePath: oldPluginPath,
        installPath: oldPluginPath,
      };
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_RUNTIME_LOG: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_CLAWHUB_URL: clawhub.url,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: scenario.unbundled || scenario.valid ? "1" : "0",
        CLAWHUB_TOKEN: "synthetic-fixture-token",
        CLAWHUB_DISABLE_TELEMETRY: scenario.valid ? "" : "1",
        CLAWDHUB_DISABLE_TELEMETRY: scenario.valid ? "" : "1",
        NPM_CONFIG_REGISTRY: npmUrl,
        npm_config_registry: npmUrl,
        NPM_CONFIG_CACHE: path.join(stateDir, "npm-cache"),
        npm_config_cache: path.join(stateDir, "npm-cache"),
      };
      const cliEntry = scenario.unbundled
        ? ["--import", offlineCatalogBootstrap, "openclaw.mjs"]
        : ["openclaw.mjs"];
      const run = async (...args: string[]) => {
        const result = await runNodeScript([...cliEntry, ...args], env, 30_000, {
          cwd: process.cwd(),
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.error, output).toBeUndefined();
        return { ...result, output };
      };
      if (!scenario.valid) {
        await seedInstalledPluginIndex({ [PLUGIN]: originalRecord }, { stateDir, config, env });
      }
      await closeOpenClawStateDatabaseAsync();
      const beforeRecords = await readRecords(stateDir);
      const validation = await run("config", "validate", "--json");
      if (!scenario.valid) {
        expect(validation.status, validation.output).not.toBe(0);
        expect(validation.output).toContain(`invalid config for plugin ${PLUGIN}:`);
      } else {
        expect(validation.status, validation.output).toBe(0);
      }
      const npmRoot = path.join(stateDir, "npm");
      await fs.mkdir(npmRoot, { recursive: true });
      const sentinel = path.join(npmRoot, "untouched.txt");
      await fs.writeFile(sentinel, "existing payload stays intact\n");
      await fs.writeFile(catalogRequestsPath, "");
      npmRequests.length = 0;
      clawhub.requests.length = 0;
      const result = await run(
        "plugins",
        "install",
        scenario.spec,
        ...(scenario.valid ? [] : ["--force", "--no-enable"]),
        "--accept-capabilities",
      );
      const { output } = result;
      const records = await readRecords(stateDir);
      const catalogRequests = (await readText(catalogRequestsPath)).split("\n").filter(Boolean);
      expect(await readText(sentinel)).toBe("existing payload stays intact\n");
      if (scenario.source === null) {
        expect(result.status, output).not.toBe(0);
        expect(output).toContain(scenario.error ?? `invalid config for plugin ${PLUGIN}:`);
        expect(npmRequests, scenario.spec).toEqual([]);
        if (!scenario.valid) {
          expect(clawhub.requests, scenario.spec).toEqual([]);
        } else {
          const download = `GET /api/v1/packages/${encodeURIComponent(PACKAGE)}/download`;
          if (scenario.downloaded) {
            expect(clawhub.requests).toContain(download);
          } else {
            expect(clawhub.requests).not.toContain(download);
            expect(clawhub.requests).not.toContain(
              `GET /api/v1/packages/${encodeURIComponent(PACKAGE)}/versions/${VERSION}/security`,
            );
          }
        }
        expect(clawhub.telemetry).toEqual([]);
        expect(await readText(configPath)).toBe(originalConfig);
        expect(records).toEqual(beforeRecords);
        expect(await fs.readdir(npmRoot)).toEqual(["untouched.txt"]);
        expect(await readText(oldManifestPath)).toBe(JSON.stringify(oldManifest));
        expect(await readText(path.join(oldPluginPath, "dist/index.js"))).toBe(PAYLOAD);
        await expect(fs.access(path.join(stateDir, "extensions"))).rejects.toHaveProperty(
          "code",
          "ENOENT",
        );
        continue;
      }
      if (scenario.unbundled) {
        expect(catalogRequests).toContain('"https://clawhub.ai/v1/feeds/plugins"');
      }
      expect(result.status, output).toBe(0);
      const persistedConfig = JSON.parse(await readText(configPath)) as OpenClawConfig;
      if (!scenario.valid) {
        expect(persistedConfig.channels).toEqual(config.channels);
        expect(persistedConfig.plugins?.entries?.[PLUGIN]).toEqual(
          config.plugins?.entries?.[PLUGIN],
        );
      }
      expect(records?.[PLUGIN], output).toMatchObject({ source: scenario.source });
      const installPath = records?.[PLUGIN]?.installPath;
      expect(installPath).toBeTruthy();
      expect(installPath).not.toBe(oldPluginPath);
      expect(await readText(path.join(installPath!, "dist/index.js"))).toBe(PAYLOAD);
      if (scenario.source === "npm") {
        expect(npmRequests.some((request) => request.includes("/-/"))).toBe(true);
        expect(clawhub.requests).toEqual([]);
      } else if (scenario.source === "clawhub") {
        expect(clawhub.requests).toContain(
          `GET /api/v1/packages/${encodeURIComponent(PACKAGE)}/download`,
        );
        expect(npmRequests).toEqual([]);
        expect(records?.[PLUGIN]).toMatchObject({
          source: "clawhub",
          clawhubPackage: PACKAGE,
          version: VERSION,
        });
        expect(clawhub.requests).toContain(
          `GET /api/v1/packages/${encodeURIComponent(PACKAGE)}/versions/${VERSION}/security`,
        );
        const event = { event: "plugin_install", packageName: PACKAGE, version: VERSION };
        expect(clawhub.telemetry).toEqual([event]);
        if (scenario.repeat) {
          const repeat = await run(
            "plugins",
            "install",
            `clawhub:${PACKAGE}@${VERSION}`,
            "--force",
            "--accept-capabilities",
          );
          expect(repeat.status, repeat.output).toBe(0);
          expect(clawhub.telemetry).toEqual([event, event]);
        }
      } else {
        expect(npmRequests).toEqual([]);
        expect(clawhub.requests).toEqual([]);
      }
      const repairedValidation = await run("config", "validate", "--json");
      expect(repairedValidation.status, repairedValidation.output).toBe(0);
      expect(JSON.parse(repairedValidation.stdout)).toMatchObject({ valid: true });
    }
  } finally {
    for (const clawhub of clawhubs) {
      await clawhub.close();
    }
    for (const server of npmServers) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

it("confines invalid-config recovery to npm catalog and canonical-ID owners through CLI persistence", async () => {
  await verifyInstalls(scenarios.slice(0, 5));
}, 120_000);

it("reports fresh ClawHub installs and repeat updates after persistence", async () => {
  await verifyInstalls([scenarios[5]!]);
}, 60_000);

it.each(scenarios.slice(6))(
  "keeps ClawHub install failure isolated: %j",
  async (scenario) => {
    await verifyInstalls([scenario]);
  },
  30_000,
);
