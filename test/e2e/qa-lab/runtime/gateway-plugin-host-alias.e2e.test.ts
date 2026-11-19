import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { refreshStartupPluginQuarantine } from "../../../../src/commands/doctor-config-preflight-plugin-verification.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resolveOpenClawPackageRootSync } from "../../../../src/infra/openclaw-root.js";
import { resolvePluginArtifactDeclaredSurface } from "../../../../src/plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../../../../src/plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../../src/plugins/capability-summary.js";
import { installPluginFromPath } from "../../../../src/plugins/install.js";
import { safeRealpathSync } from "../../../../src/plugins/path-safety.js";
import { setActiveDegradedPlugins } from "../../../../src/plugins/runtime-degraded-state.js";
import { seedInstalledPluginIndex } from "../../../../src/plugins/test-helpers/installed-plugin-index.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";
import { resetGatewayState } from "./gateway-startup-routing.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetGatewayState);
afterEach(() => {
  setActiveDegradedPlugins([]);
  resetGatewayState();
});

// Windows uses a case-variant spelling of the actual running host. POSIX supplies
// a real symlink alias to qualify the same installer, preflight and Gateway flow.
it(
  "starts an installed plugin service through a host alias after installation and reinstall",
  {
    timeout: 120_000,
  },
  async () => {
    const home = tempDirs.make("openclaw-host-alias-gateway-");
    const stateDir = path.join(home, "state");
    const workspace = path.join(home, "workspace");
    const bundledPlugins = path.join(home, "empty-bundled");
    const source = path.join(home, "source");
    const extensionsDir = path.join(stateDir, "extensions");
    const configPath = path.join(stateDir, "openclaw.json");
    const id = "host-alias-proof";
    const method = "host-alias-proof.probe";
    const token = randomUUID();
    const host = resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
    assert(host, "the actual source checkout must be discoverable");
    const hostRoot = await fs.realpath(host);
    let hostAlias: string;
    if (process.platform === "win32") {
      const basename = path.basename(hostRoot);
      const variant =
        basename === basename.toUpperCase() ? basename.toLowerCase() : basename.toUpperCase();
      expect(variant).not.toBe(basename);
      hostAlias = path.join(path.dirname(hostRoot), variant);
    } else {
      hostAlias = path.join(home, "host-alias");
      await fs.symlink(hostRoot, hostAlias, "junction");
    }
    const [actualHost, aliasedHost] = await Promise.all([fs.stat(hostRoot), fs.stat(hostAlias)]);
    expect([aliasedHost.dev, aliasedHost.ino]).toEqual([actualHost.dev, actualHost.ino]);
    await Promise.all(
      [stateDir, workspace, bundledPlugins, source].map((dir) =>
        fs.mkdir(dir, { recursive: true }),
      ),
    );
    await Promise.all([
      fs.writeFile(
        path.join(source, "package.json"),
        JSON.stringify({
          name: id,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
          peerDependencies: { openclaw: "*" },
          peerDependenciesMeta: { openclaw: { optional: true } },
          openclaw: { extensions: ["./index.cjs"] },
        }),
      ),
      fs.writeFile(
        path.join(source, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false },
        }),
      ),
      fs.writeFile(
        path.join(source, "index.cjs"),
        'module.exports = { id: "host-alias-proof", register(api) { let started = false; api.registerService({ id: "host-alias-proof", start() { started = true; }, stop() { started = false; } }); api.registerGatewayMethod("host-alias-proof.probe", ({ respond }) => respond(true, { started })); } };',
      ),
    ]);
    await withEnvAsync(
      {
        ...isolatedGatewayEnv,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPlugins,
      },
      async () => {
        const installPath = path.join(extensionsDir, id);
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace, skipBootstrap: true }, entries: { main: {} } },
          plugins: {
            enabled: true,
            slots: { memory: "none" },
            allow: [id],
            load: { paths: [installPath] },
            entries: { [id]: { enabled: true } },
          },
          gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
        };
        await fs.writeFile(configPath, JSON.stringify(cfg));
        for (const mode of ["install", "update"] as const) {
          const installed = await installPluginFromPath({
            path: source,
            extensionsDir,
            mode,
            config: cfg,
          });
          if (!installed.ok) {
            throw new Error(installed.error ?? "Plugin installation failed");
          }
          expect(installed.targetDir).toBe(installPath);
          const peer = path.join(installPath, "node_modules", "openclaw");
          // Reproduce the reported on-disk junction spelling without mocking resolution.
          await fs.unlink(peer);
          await fs.symlink(hostAlias, peer, "junction");
          const recordedTarget = await fs.readlink(peer);
          if (process.platform === "win32") {
            expect(safeRealpathSync(peer)).not.toBe(safeRealpathSync(hostRoot));
          }
          // The payload is really installed above. Only its persisted install-source
          // record is seeded; the production preflight and runtime owners stay real.
          await seedInstalledPluginIndex(
            { [id]: { source: "git", installPath, version: "1.0.0" } },
            {
              env: process.env,
              config: cfg,
            },
          );
          await resolvePluginCapabilityConsent({
            config: cfg,
            pluginId: id,
            env: process.env,
            acknowledge: {
              reviewToken: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installPath, process.env, { config: cfg }),
              ),
            },
          });
          const convergence = await refreshStartupPluginQuarantine({ cfg, env: process.env });
          setActiveDegradedPlugins(convergence.quarantinedPlugins);
          // A repairing preflight must not silently erase the reproducing junction.
          expect(await fs.readlink(peer)).toBe(recordedTarget);
          let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
          try {
            gateway = await startGatewayWithClient({
              cfg,
              configPath,
              token,
              scopes: ["operator.admin"],
            });
            await gateway.server.startupSettled;
            expect(await gateway.client.request(method, {})).toEqual({ started: true });
            expect(convergence.quarantinedPlugins).toEqual([]);
          } finally {
            if (gateway) {
              try {
                await disconnectGatewayClient(gateway.client);
              } finally {
                await gateway.server.close({ reason: "Host alias admission proof complete" });
              }
            }
          }
        }
      },
    );
  },
);
