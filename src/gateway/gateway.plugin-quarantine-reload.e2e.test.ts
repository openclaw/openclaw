import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { linkOpenClawPeerDependencies } from "../plugins/plugin-peer-link.js";
import {
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("reloads only the requested startup-quarantined plugin after an in-place repair", async () => {
  await using state = await createStartupTestState("quarantine-reload", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
  });
  state.applyEnv();
  const token = "synthetic-plugin-reload-token";
  const ids = ["repair-target", "repair-bystander"];
  const peerDependencies = { openclaw: "*" };
  const cfg = {
    plugins: {
      allow: ids,
      entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
      slots: { memory: "none" },
    },
    gateway: { auth: { mode: "token" as const, token } },
  };
  const records: Record<string, PluginInstallRecord & { installPath: string }> = {};
  for (const id of ids) {
    const installPath = path.join(state.stateDir, "git", id, "repo");
    await fs.mkdir(installPath, { recursive: true });
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: id,
        version: "1.0.0",
        peerDependencies,
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(
      path.join(installPath, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        activation: { onStartup: true },
        configSchema: { type: "object" },
      }),
    );
    await fs.writeFile(path.join(installPath, "index.cjs"), "module.exports = { register() {} };");
    const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath, state.env, {
      config: cfg,
    });
    records[id] = {
      source: "git",
      installPath,
      version: "1.0.0",
      acceptedSurface,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
    };
  }
  await state.writeConfig(cfg);
  await seedInstalledPluginIndex(records, { config: cfg, env: process.env });
  onTestFinished(() => setActiveDegradedPlugins([]));
  const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
  await preflight.pluginCache?.[Symbol.asyncDispose]();
  const quarantined = () =>
    listActiveDegradedPlugins()
      .map((entry) => entry.pluginId)
      .toSorted();
  expect(quarantined()).toEqual(ids.toSorted());
  const { client, server } = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    token,
    scopes: ["operator.admin", "operator.read", "operator.write"],
  });
  try {
    await server.startupSettled;
    const reload = () =>
      client.request("plugins.reload", { plugins: [{ pluginId: "repair-target" }] });
    await expect(reload()).rejects.toThrow(/missing-openclaw-peer-link/);
    expect(quarantined()).toEqual(ids.toSorted());
    for (const record of Object.values(records)) {
      expect(
        await linkOpenClawPeerDependencies({
          installedDir: record.installPath,
          peerDependencies,
          logger: {},
        }),
      ).toMatchObject({ repaired: 1 });
    }
    await reload();
    expect(quarantined()).toEqual(["repair-bystander"]);
    expect(
      getActivePluginRegistry()?.plugins.find((plugin) => plugin.id === "repair-target"),
    ).toMatchObject({ status: "loaded", activated: true });
  } finally {
    await disconnectGatewayClient(client);
    await server.close();
  }
});
