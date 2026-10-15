import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { resolveProactiveDeliveryTargetWithSessionRoute } from "../infra/outbound/targets.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { recoverCommandOwnerTargetKinds } from "./doctor-command-owner-recovery.js";
import { migrateLegacyCommandOwners } from "./doctor-command-owner.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const { discordPlugin, discordSetupPlugin } = await loadBundledPluginFacade<{
  discordPlugin: ChannelPlugin;
  discordSetupPlugin: ChannelPlugin;
}>({
  pluginId: "discord",
  artifactBasename: "api.ts",
});
const { telegramPlugin, telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramPlugin: ChannelPlugin;
  telegramSetupPlugin: ChannelPlugin;
}>({
  pluginId: "telegram",
  artifactBasename: "api.ts",
});
const registry = createTestRegistry([
  { pluginId: "discord", plugin: discordPlugin, source: "test" },
  { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "Doctor reports or repairs a stripped owner (history: %s)",
  async (history) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const cfg = { ...config(`discord:${owner}`), plugins: { enabled: false } };
        const configPath = await writeOpenClawConfig(home, cfg);
        if (history) {
          await fs.writeFile(`${configPath}.bak`, JSON.stringify(cfg));
          await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(config()));
        }
        expect(
          await resolveProactiveDeliveryTargetWithSessionRoute({ cfg, agentId: "main" }),
        ).toMatchObject({ channel: "none", reason: "no-route" });
        await using ctx = await withPluginRuntimeRegistryScope(registry, () =>
          prepareDoctorContext(configPath),
        );
        if (history) {
          expect(ctx.configResult.pendingChangePanels?.join("\n")).toContain(
            "Restored commands.ownerAllowFrom[0] target kind",
          );
          await runInitialConfigWriteHealth(ctx);
          expect(ctx.configWriteRefusal).toBeUndefined();
          const saved = await readConfigFileSnapshot();
          expect(saved.config.commands?.ownerAllowFrom).toEqual([`discord:user:${owner}`]);
          expect(
            await withPluginRuntimeRegistryScope(registry, () =>
              resolveProactiveDeliveryTargetWithSessionRoute({
                cfg: saved.config,
                agentId: "main",
              }),
            ),
          ).toMatchObject({ channel: "discord", to: `user:${owner}`, chatType: "direct" });
        } else {
          expect(ctx.cfg.commands?.ownerAllowFrom).toEqual([`discord:${owner}`]);
          expect(ctx.configResult.warnings?.join("\n")).toContain('reason="no-route"');
          expect(ctx.configResult.warnings?.join("\n")).toContain(
            `set commands.ownerAllowFrom[0] to "discord:user:${owner}"`,
          );
        }
      });
    });
  },
);

it("recovers an installed channel's owner kind without a runtime registry", async () => {
  const home = tempDirs.make("doctor-owner-installed-");
  const pluginDir = path.join(home, "plugin");
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@fixture/discord-owner",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: "./setup-entry.cjs",
        channel: { id: "discord" },
      },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "discord",
      channels: ["discord"],
      configSchema: { type: "object", properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    'throw new Error("Doctor must not activate the runtime");',
  );
  // The installed entry returns the real setup contract without recompiling its source graph.
  await fs.writeFile(
    path.join(pluginDir, "setup-entry.cjs"),
    "module.exports = { plugin: globalThis.__doctorOwnerSetup };",
  );
  vi.stubGlobal("__doctorOwnerSetup", discordSetupPlugin);
  const cfg = {
    ...config(`discord:${owner}`),
    plugins: { allow: ["discord"], load: { paths: [pluginDir] } },
  };
  const configPath = path.join(home, "openclaw.json");
  await fs.writeFile(`${configPath}.bak`, JSON.stringify(config()));
  setActivePluginRegistry(createTestRegistry());
  await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
    const result = recoverCommandOwnerTargetKinds({
      config: cfg,
      snapshot: { path: configPath, parsed: cfg },
    });
    expect(result.config.commands?.ownerAllowFrom).toEqual([`discord:user:${owner}`]);
    expect(result.warnings).toEqual([]);
  });
});

it.each(["different-owner", "include", "invalid", "symlink"])(
  "does not search past %s history to guess an owner kind",
  async (history) => {
    const home = tempDirs.make("doctor-owner-history-");
    const cfg = { ...config(`discord:${owner}`), plugins: { enabled: false } };
    const configPath = path.join(home, "openclaw.json");
    await fs.writeFile(`${configPath}.bak.1`, JSON.stringify(config()));
    if (history === "symlink") {
      await fs.symlink(`${configPath}.bak.1`, `${configPath}.bak`);
    } else {
      await fs.writeFile(
        `${configPath}.bak`,
        history === "invalid"
          ? "{"
          : JSON.stringify(
              history === "include"
                ? { $include: "old.json" }
                : config("discord:100000000000000002"),
            ),
      );
    }
    const result = recoverCommandOwnerTargetKinds({
      config: cfg,
      snapshot: { path: configPath, parsed: cfg },
    });
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(`"discord:user:${owner}"`);
  },
);
const registrySnapshot = captureActivePluginRegistrySnapshot();
beforeEach(() => {
  setActivePluginRegistry(registry);
});

it.each(["runtime", "setup"])(
  "normalizes a legacy owner using the unambiguous Telegram %s contract",
  (surface) => {
    if (surface === "setup") {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramSetupPlugin, source: "test" }]),
      );
    }
    const migrated = migrateLegacyCommandOwners(
      { commands: { ownerAllowFrom: ["telegram:user:123"] } },
      [],
    );
    expect(migrated.commands?.ownerAllowFrom).toEqual(["telegram:123"]);
  },
);
afterEach(() => {
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  vi.unstubAllGlobals();
});

const owner = "100000000000000001";
function config(ownerEntry = `discord:user:${owner}`): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    channels: { discord: { token: "test-token" } },
    commands: { ownerAllowFrom: [ownerEntry] },
  };
}

it("keeps a Discord owner's direct heartbeat route and command authority through Doctor", async () => {
  const original = config();
  expect(
    await resolveProactiveDeliveryTargetWithSessionRoute({ cfg: original, agentId: "main" }),
  ).toMatchObject({ channel: "discord", to: `user:${owner}`, chatType: "direct" });
  const migrated = migrateLegacyCommandOwners(original, []);
  expect(
    await resolveProactiveDeliveryTargetWithSessionRoute({ cfg: migrated, agentId: "main" }),
  ).toMatchObject({ channel: "discord", to: `user:${owner}`, chatType: "direct" });
  expect(migrated.commands?.ownerAllowFrom).toEqual([`discord:user:${owner}`]);
  for (const senderId of [owner, "100000000000000002"]) {
    expect(
      resolveCommandAuthorization({
        cfg: migrated,
        ctx: { Provider: "discord", Surface: "discord", SenderId: senderId },
        commandAuthorized: true,
      }).senderIsOwner,
    ).toBe(senderId === owner);
  }
});
