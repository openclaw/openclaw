import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import JSZip from "jszip";
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
import { reserveTestPortListener } from "../test-utils/port-claims.js";

const PACKAGE = "@openclaw/brave-plugin";
const VERSION = "1.0.0";
const PLUGIN = "brave";
const PAYLOAD = "export default function register() {}\n";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function startClawHubFixture(packageDir: string) {
  const zip = new JSZip();
  for (const file of ["package.json", "openclaw.plugin.json", "dist/index.js"]) {
    zip.file(`package/${file}`, await fs.readFile(path.join(packageDir, file)));
  }
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const sha256hash = createHash("sha256").update(archive).digest("hex");
  const requests: string[] = [];
  const packagePath = `/api/v1/packages/${encodeURIComponent(PACKAGE)}`;
  const pkg = { name: PACKAGE, family: "code-plugin", runtimeId: PLUGIN };
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        requests.push(`${request.method} ${pathname}`);
        let body: unknown;
        if (pathname === packagePath) {
          body = {
            package: { ...pkg, latestVersion: VERSION, tags: { latest: VERSION } },
          };
        } else if (pathname === `${packagePath}/versions/${VERSION}/artifact`) {
          body = { package: pkg, version: { version: VERSION, sha256hash, compatibility: {} } };
        } else if (pathname === `${packagePath}/versions/${VERSION}/security`) {
          body = {
            package: pkg,
            release: { version: VERSION },
            overview: "Synthetic recovery fixture.",
            securityAuditUrl: `http://${request.headers.host}${pathname}`,
            trust: {
              scanStatus: "clean",
              moderationState: null,
              blockedFromDownload: false,
              reasons: [],
              pending: false,
              stale: false,
            },
          };
        } else if (pathname === `${packagePath}/download`) {
          response.writeHead(200, { "content-type": "application/zip" });
          response.end(archive);
          return;
        } else {
          response.writeHead(404);
          response.end("unknown fixture route");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      }),
  });
  return {
    url: `http://127.0.0.1:${reservation.claim.port}`,
    requests,
    async close() {
      await reservation.releaseListener();
      await reservation.claim.release();
    },
  };
}

async function readRecords(stateDir: string) {
  // The CLI writes in another process; observe its committed ledger, not this process's prior read.
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const records = await readPersistedInstalledPluginIndexInstallRecordsAsync({ stateDir });
  await closeOpenClawStateDatabaseAsync();
  return records;
}

it("confines invalid-config recovery to npm catalog and canonical-ID owners through CLI persistence", async () => {
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
  const clawhub = await startClawHubFixture(packageDir);

  try {
    for (const [index, scenario] of [
      { spec: `${PACKAGE}@${VERSION}`, source: null },
      { spec: `clawhub:${PACKAGE}@${VERSION}`, source: null },
      { spec: `npm:${PACKAGE}@${VERSION}`, source: "npm" },
      { spec: PLUGIN, source: "path" },
      { spec: PLUGIN, source: "npm", unbundled: true },
      // The denied selectors have a usable artifact, independently of config recovery.
      { spec: `clawhub:${PACKAGE}@${VERSION}`, source: "clawhub", valid: true },
    ].entries()) {
      const stateDir = path.join(root, `state-${index}`);
      const oldPluginPath = path.join(stateDir, "previous-plugin");
      const configPath = path.join(stateDir, "openclaw.json");
      const config: OpenClawConfig = {
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
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: scenario.unbundled ? "1" : "0",
        CLAWHUB_TOKEN: "synthetic-fixture-token",
        CLAWHUB_DISABLE_TELEMETRY: "1",
        CLAWDHUB_DISABLE_TELEMETRY: "1",
        NPM_CONFIG_REGISTRY: npmUrl,
        npm_config_registry: npmUrl,
        NPM_CONFIG_CACHE: path.join(stateDir, "npm-cache"),
        npm_config_cache: path.join(stateDir, "npm-cache"),
      };
      const cliEntry = scenario.unbundled
        ? ["--import", offlineCatalogBootstrap, "openclaw.mjs"]
        : ["openclaw.mjs"];
      await seedInstalledPluginIndex({ [PLUGIN]: originalRecord }, { stateDir, config, env });
      await closeOpenClawStateDatabaseAsync();
      const beforeRecords = await readRecords(stateDir);
      const validation = await runNodeScript(
        [...cliEntry, "config", "validate", "--json"],
        env,
        30_000,
        { cwd: process.cwd() },
      );
      const validationOutput = `${validation.stdout}\n${validation.stderr}`;
      expect(validation.error, validationOutput).toBeUndefined();
      if (!scenario.valid) {
        expect(validation.status, validationOutput).not.toBe(0);
        expect(validationOutput).toContain(`invalid config for plugin ${PLUGIN}:`);
      } else {
        expect(validation.status, validationOutput).toBe(0);
      }
      const npmRoot = path.join(stateDir, "npm");
      await fs.mkdir(npmRoot, { recursive: true });
      const sentinel = path.join(npmRoot, "untouched.txt");
      await fs.writeFile(sentinel, "existing payload stays intact\n");
      await fs.writeFile(catalogRequestsPath, "");
      npmRequests.length = 0;
      clawhub.requests.length = 0;
      const result = await runNodeScript(
        [
          ...cliEntry,
          "plugins",
          "install",
          scenario.spec,
          "--force",
          "--no-enable",
          "--accept-capabilities",
        ],
        env,
        30_000,
        { cwd: process.cwd() },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      const records = await readRecords(stateDir);
      const catalogRequests = (await fs.readFile(catalogRequestsPath, "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(await fs.readFile(sentinel, "utf8")).toBe("existing payload stays intact\n");
      if (process.env.OPENCLAW_E2E_VERBOSE === "1") {
        console.info(
          JSON.stringify({
            spec: scenario.spec,
            invalidConfig: !scenario.valid,
            bundled: !scenario.unbundled,
            exit: result.status,
            npmRequests: npmRequests.length,
            clawhubRequests: clawhub.requests.length,
            hostedCatalogRequests: catalogRequests.length,
            persistedSource: records?.[PLUGIN]?.source,
            configChanged: (await fs.readFile(configPath, "utf8")) !== originalConfig,
          }),
        );
      }
      if (scenario.source === null) {
        expect(result.status, output).not.toBe(0);
        expect(output).toContain(`invalid config for plugin ${PLUGIN}:`);
        expect(npmRequests, scenario.spec).toEqual([]);
        expect(clawhub.requests, scenario.spec).toEqual([]);
        expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
        expect(records).toEqual(beforeRecords);
        expect(await fs.readdir(npmRoot)).toEqual(["untouched.txt"]);
        expect(await fs.readFile(oldManifestPath, "utf8")).toBe(JSON.stringify(oldManifest));
        expect(await fs.readFile(path.join(oldPluginPath, "dist/index.js"), "utf8")).toBe(PAYLOAD);
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
      const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
      expect(persistedConfig.channels).toEqual(config.channels);
      expect(persistedConfig.plugins?.entries?.[PLUGIN]).toEqual(config.plugins?.entries?.[PLUGIN]);
      expect(records?.[PLUGIN], output).toMatchObject({ source: scenario.source });
      const installPath = records?.[PLUGIN]?.installPath;
      expect(installPath).toBeTruthy();
      expect(installPath).not.toBe(oldPluginPath);
      expect(await fs.readFile(path.join(installPath!, "dist/index.js"), "utf8")).toBe(PAYLOAD);
      if (scenario.source === "npm") {
        expect(npmRequests.some((request) => request.includes("/-/"))).toBe(true);
        expect(clawhub.requests).toEqual([]);
      } else if (scenario.source === "clawhub") {
        expect(clawhub.requests).toContain(
          `GET /api/v1/packages/${encodeURIComponent(PACKAGE)}/download`,
        );
        expect(npmRequests).toEqual([]);
      } else {
        expect(npmRequests).toEqual([]);
        expect(clawhub.requests).toEqual([]);
      }
      const repairedValidation = await runNodeScript(
        [...cliEntry, "config", "validate", "--json"],
        env,
        30_000,
        { cwd: process.cwd() },
      );
      const repairedOutput = `${repairedValidation.stdout}\n${repairedValidation.stderr}`;
      expect(repairedValidation.error, repairedOutput).toBeUndefined();
      expect(repairedValidation.status, repairedOutput).toBe(0);
      expect(JSON.parse(repairedValidation.stdout)).toMatchObject({ valid: true });
    }
  } finally {
    await clawhub.close();
    for (const server of npmServers) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}, 120_000);
