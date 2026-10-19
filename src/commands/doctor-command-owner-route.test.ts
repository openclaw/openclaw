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
import { resolveHeartbeatDeliveryTargetWithSessionRoute } from "../infra/outbound/targets.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { recoverCommandOwnerTargetKinds } from "./doctor-command-owner-recovery.js";
import { migrateLegacyCommandOwners } from "./doctor-command-owner.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const { discordPlugin, discordSetupPlugin } = await loadBundledPluginFacade<{
  discordPlugin: ChannelPlugin;
  discordSetupPlugin: ChannelPlugin;
}>({ pluginId: "discord", artifactBasename: "api.ts" });
const { telegramPlugin, telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramPlugin: ChannelPlugin;
  telegramSetupPlugin: ChannelPlugin;
}>({ pluginId: "telegram", artifactBasename: "api.ts" });
const registry = createTestRegistry([
  { pluginId: "discord", plugin: discordPlugin, source: "test" },
  { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const heartbeat = (cfg: OpenClawConfig) =>
  resolveHeartbeatDeliveryTargetWithSessionRoute({ cfg, agentId: "main" });
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const owner = "100000000000000001";
const typedOwner = `discord:user:${owner}`;
const bareOwner = `discord:${owner}`;
const directRoute = { channel: "discord", to: `user:${owner}`, chatType: "direct" };
function config(ownerEntry = typedOwner, plugins?: OpenClawConfig["plugins"]): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    channels: { discord: { token: "test-token" } },
    commands: { ownerAllowFrom: [ownerEntry] },
    ...(plugins ? { plugins } : {}),
  };
}
const recover = (cfg: OpenClawConfig, file: string) =>
  recoverCommandOwnerTargetKinds({ config: cfg, snapshot: { path: file, parsed: cfg } });

it.each([false, true])("Doctor reports or repairs a stripped owner (history: %s)", (history) =>
  withDoctorConfigPreflightHome(async (home) => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const cfg = config(bareOwner, { enabled: false });
    const configPath = await writeOpenClawConfig(home, cfg);
    if (history) {
      await writeJson(`${configPath}.bak`, cfg);
      await writeJson(`${configPath}.bak.1`, config());
    }
    expect(await heartbeat(cfg)).toMatchObject({ channel: "none", reason: "no-route" });
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
      expect(saved.config.commands?.ownerAllowFrom).toEqual([typedOwner]);
      expect(
        await withPluginRuntimeRegistryScope(registry, () => heartbeat(saved.config)),
      ).toMatchObject(directRoute);
    } else {
      expect(ctx.cfg.commands?.ownerAllowFrom).toEqual([bareOwner]);
      const warnings = ctx.configResult.warnings?.join("\n");
      expect(warnings).toContain('reason="no-route"');
      expect(warnings).toContain(`set commands.ownerAllowFrom[0] to "${typedOwner}"`);
    }
  }),
);

it("recovers an installed channel's owner kind without a runtime registry", async () => {
  const home = tempDirs.make("doctor-owner-installed-");
  const pluginDir = path.join(home, "plugin");
  await fs.mkdir(pluginDir);
  await writeJson(path.join(pluginDir, "package.json"), {
    name: "@fixture/discord-owner",
    version: "1.0.0",
    openclaw: {
      extensions: ["./index.cjs"],
      setupEntry: "./setup-entry.cjs",
      channel: { id: "discord" },
    },
  });
  await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: "discord",
    channels: ["discord"],
    configSchema: { type: "object", properties: {} },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    'throw new Error("Doctor must not activate the runtime");',
  );
  await fs.writeFile(
    path.join(pluginDir, "setup-entry.cjs"),
    "module.exports = { plugin: globalThis.__doctorOwnerSetup };",
  );
  vi.stubGlobal("__doctorOwnerSetup", discordSetupPlugin);
  const cfg = config(bareOwner, { allow: ["discord"], load: { paths: [pluginDir] } });
  const configPath = path.join(home, "openclaw.json");
  await writeJson(`${configPath}.bak`, config());
  setActivePluginRegistry(createTestRegistry());
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const result = recover(cfg, configPath);
  expect(result.config.commands?.ownerAllowFrom).toEqual([typedOwner]);
  expect(result.warnings).toEqual([]);
});

it.each([
  ["different-owner", JSON.stringify(config("discord:100000000000000002"))],
  ["include", '{"$include":"old.json"}'],
  ["invalid", "{"],
  ["symlink", undefined],
])("does not search past %s history to guess an owner kind", async (_history, raw) => {
  const home = tempDirs.make("doctor-owner-history-");
  const cfg = config(bareOwner, { enabled: false });
  const configPath = path.join(home, "openclaw.json");
  await writeJson(`${configPath}.bak.1`, config());
  if (raw === undefined) {
    await fs.symlink(`${configPath}.bak.1`, `${configPath}.bak`);
  } else {
    await fs.writeFile(`${configPath}.bak`, raw);
  }
  const result = recover(cfg, configPath);
  expect(result.config).toBe(cfg);
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain(`"${typedOwner}"`);
});
const registrySnapshot = captureActivePluginRegistrySnapshot();
beforeEach(() => setActivePluginRegistry(registry));

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
  vi.unstubAllEnvs();
});

it("keeps a Discord owner's direct heartbeat route and command authority through Doctor", async () => {
  const original = config();
  expect(await heartbeat(original)).toMatchObject(directRoute);
  const migrated = migrateLegacyCommandOwners(original, []);
  expect(await heartbeat(migrated)).toMatchObject(directRoute);
  expect(migrated.commands?.ownerAllowFrom).toEqual([typedOwner]);
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
