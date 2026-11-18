import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPluginFromNpmSpec } from "../../plugins/install-npm.js";
import {
  packPlugins,
  startStaticRegistry,
} from "../../plugins/test-helpers/npm-registry-fixtures.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { preflightConfiguredNpmPluginTargets } from "./update-command-plugin-preflight.js";

const tempDirs = createTrackedTempDirs();
const servers: http.Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await tempDirs.cleanup();
});

it.each(["unchanged", "changed", "cache-evicted", "env-only-cache"] as const)(
  "prefetches without activation and preserves normal installation when %s",
  { timeout: 120_000 },
  async (scenario) => {
    const root = await tempDirs.make("openclaw-update-prefetch-");
    const name = `prefetch-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const pluginId = "prefetch-fixture";
    const marker = path.join(root, "executed");
    const cache = path.join(root, "cache");
    const home = path.join(root, "home");
    await fs.mkdir(home);
    vi.stubEnv("HOME", home);
    const userconfig = path.join(root, "user.npmrc");
    const globalconfig = path.join(root, "global.npmrc");
    await fs.writeFile(userconfig, scenario === "env-only-cache" ? "" : `cache=${cache}\n`);
    await fs.writeFile(globalconfig, "");
    for (const [key, value] of Object.entries({ cache, userconfig, globalconfig })) {
      vi.stubEnv(`npm_config_${key}`, value);
      vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, value);
    }
    const versions = await packPlugins(root, [
      { packageName: name, pluginId, version: "1.0.0" },
      {
        packageName: name,
        pluginId,
        version: "2.0.0",
        indexJs: `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "executed"); throw new Error("Plugin entry must not run during preparation");`,
      },
      { packageName: name, pluginId, version: "3.0.0" },
    ]);
    // Packing fixture sources can seed npm's content cache. Start the transport
    // observation cold so a later version cannot be satisfied by fixture setup.
    await Promise.all(
      [cache, path.join(home, ".npm")].map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    const registry = await startStaticRegistry(
      [{ packageName: name, latest: "2.0.0", versions }],
      servers,
    );
    vi.stubEnv("npm_config_registry", registry);
    vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    let archiveRequests = 0;
    const requests: string[] = [];
    servers.at(-1)!.on("request", (request) => {
      requests.push(request.url ?? "");
      if (request.url?.endsWith(".tgz")) {
        archiveRequests++;
      }
    });
    const params = {
      config: { plugins: { entries: { [pluginId]: { enabled: true } } } },
      installRecords: {
        [pluginId]: {
          source: "npm" as const,
          spec: `${name}@latest`,
          installPath: path.join(root, `package-${name}-1.0.0`),
          version: "1.0.0",
        },
      },
      env: { ...process.env },
      targetVersion: "2026.11.4",
      channel: "stable" as const,
      timeoutMs: 30_000,
      prefetch: true,
    };
    expect(await preflightConfiguredNpmPluginTargets({ ...params, prefetch: false })).toEqual([]);
    expect(archiveRequests).toBe(0);
    expect(
      await preflightConfiguredNpmPluginTargets({
        ...params,
        config: { ...params.config, security: { installPolicy: { enabled: true } } },
      }),
    ).toEqual([]);
    expect(archiveRequests).toBe(0);
    expect(await preflightConfiguredNpmPluginTargets(params), JSON.stringify(requests)).toEqual([]);
    expect(archiveRequests).toBe(1);
    expect(await fs.readdir(path.join(root, "state")).catch(() => [])).toEqual([]);
    if (scenario === "cache-evicted") {
      await fs.rm(cache, { recursive: true, force: true });
    }
    if (scenario === "changed") {
      const changedRegistry = await startStaticRegistry(
        [{ packageName: name, latest: "3.0.0", versions }],
        servers,
      );
      vi.stubEnv("npm_config_registry", changedRegistry);
      vi.stubEnv("NPM_CONFIG_REGISTRY", changedRegistry);
      servers.at(-1)!.on("request", (request) => {
        if (request.url?.endsWith(".tgz")) {
          archiveRequests++;
        }
      });
    }
    const result = await installPluginFromNpmSpec({
      spec: `${name}@latest`,
      npmDir: path.join(root, "npm"),
      expectedPluginId: pluginId,
      timeoutMs: 30_000,
      logger: { info() {}, warn() {} },
    });
    const selected = versions[scenario === "changed" ? 2 : 1]!;
    expect(result).toMatchObject({
      ok: true,
      version: scenario === "changed" ? "3.0.0" : "2.0.0",
      npmResolution: { integrity: selected.integrity },
    });
    expect(archiveRequests).toBe(scenario === "changed" || scenario === "cache-evicted" ? 2 : 1);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
  },
);
