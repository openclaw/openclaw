import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../../plugins/installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const beforeConsentReturns = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../cli/plugin-capability-consent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cli/plugin-capability-consent.js")>();
  return {
    ...actual,
    resolvePluginCapabilityConsentCliOptions: (
      params: Parameters<typeof actual.resolvePluginCapabilityConsentCliOptions>[0],
    ) => {
      const options = actual.resolvePluginCapabilityConsentCliOptions(params);
      const consent = options.onCapabilityConsent;
      return consent
        ? {
            ...options,
            onCapabilityConsent: async (...args: Parameters<typeof consent>) => {
              const accepted = await consent(...args);
              await beforeConsentReturns();
              return accepted;
            },
          }
        : options;
    },
  };
});

afterEach(() => {
  beforeConsentReturns.mockReset();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});

describe("/plugins live owner authority", () => {
  it.each(["install ./candidate", "enable authority-plugin", "disable authority-plugin"])(
    "rejects a stale owner snapshot before %s",
    async (action) => {
      await withTempHome("openclaw-plugins-stale-owner-", async (home) => {
        const params = buildPluginsCommandParams({
          commandBodyNormalized: `/plugins ${action}`,
          workspaceDir: home,
        });
        delete params.ctx.GatewayClientScopes;
        params.command.assertOwnerCurrent = () => {
          throw new Error("owner authority revoked");
        };

        const result = await handlePluginsCommand(params, true);

        expect(result?.reply?.text).toBe("Your owner authority changed; send a new request.");
      });
    },
  );

  it.each([
    { action: "install", gatewayAdmin: false },
    { action: "install", gatewayAdmin: true },
    { action: "enable", gatewayAdmin: false },
    { action: "enable", gatewayAdmin: true },
  ] as const)(
    "$action after owner revocation during consent (Gateway admin: $gatewayAdmin)",
    async ({ action, gatewayAdmin }) => {
      await withTempHome("openclaw-plugins-owner-", async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const extensionsDir = path.join(stateDir, "extensions");
        const pluginId = "authority-plugin";
        const installedDir = path.join(extensionsDir, pluginId);
        const pluginDir = action === "install" ? path.join(home, "candidate") : installedDir;
        const workspaceDir = path.join(home, "workspace");
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.mkdirSync(workspaceDir, { recursive: true });
        const fixture = createColdPluginFixture({
          rootDir: pluginDir,
          pluginId,
          manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
        });
        fs.writeFileSync(
          fixture.runtimeSource,
          `module.exports = { id: "${pluginId}", register() {} };\n`,
        );
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
        const config: OpenClawConfig = {
          commands: { text: true, plugins: true },
          agents: { entries: { main: { workspace: workspaceDir } } },
          plugins: {
            enabled: true,
            slots: { memory: "none" },
            ...(action === "enable" ? { entries: { [pluginId]: { enabled: false } } } : {}),
          },
        };
        const originalConfig = JSON.stringify(config);
        fs.writeFileSync(configPath, originalConfig);
        const installRecords: Record<string, PluginInstallRecord> =
          action === "enable"
            ? {
                [pluginId]: {
                  source: "path" as const,
                  sourcePath: pluginDir,
                  installPath: pluginDir,
                },
              }
            : {};
        await writePersistedInstalledPluginIndex(
          loadInstalledPluginIndex({ config, env: process.env, installRecords }),
        );
        const params = buildPluginsCommandParams({
          commandBodyNormalized:
            action === "install"
              ? `/plugins install ${pluginDir} --force --accept-capabilities`
              : `/plugins enable ${pluginId} --accept-capabilities`,
          cfg: config,
          workspaceDir,
          ...(gatewayAdmin ? { gatewayClientScopes: ["operator.admin", "operator.write"] } : {}),
        });
        if (!gatewayAdmin) {
          delete params.ctx.GatewayClientScopes;
        }
        params.command.senderIsOwner = !gatewayAdmin;
        let ownerCurrent = true;
        params.command.assertOwnerCurrent = () => {
          if (!ownerCurrent) {
            throw new Error("owner authority revoked");
          }
        };
        const entered = createDeferredCore();
        const finish = createDeferredCore();
        beforeConsentReturns.mockImplementation(async () => {
          entered.resolve();
          await finish.promise;
        });
        const command = handlePluginsCommand(params, true).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        try {
          await Promise.race([
            entered.promise,
            command.then((outcome) => {
              throw new Error(
                `Command settled before capability review: ${formatErrorMessage(outcome.error ?? outcome.result?.reply?.text)}`,
              );
            }),
          ]);
          expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
          expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual(installRecords);
          if (action === "install") {
            expect(fs.existsSync(installedDir)).toBe(false);
            expect(fs.readdirSync(extensionsDir).length).toBeGreaterThan(0);
          }
          ownerCurrent = false;
        } finally {
          finish.resolve();
          await command;
        }
        const outcome = await command;
        if (gatewayAdmin) {
          expect(outcome.error).toBeUndefined();
          expect(outcome.result?.reply?.text).toContain(
            action === "install"
              ? `Installed plugin "${pluginId}"`
              : `Plugin "${pluginId}" enabled`,
          );
          expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({
            plugins: { entries: { [pluginId]: { enabled: true } } },
          });
          expect(readPersistedInstalledPluginIndexInstallRecords()?.[pluginId]).toMatchObject({
            installPath: installedDir,
            acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
          });
        } else {
          expect(formatErrorMessage(outcome.error ?? outcome.result?.reply?.text)).toContain(
            "owner authority revoked",
          );
          expect(fs.readFileSync(configPath, "utf8")).toBe(originalConfig);
          expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual(installRecords);
        }
        // The command must settle its private staged artifact even after caller authority is lost.
        expect(fs.readdirSync(extensionsDir)).toEqual(
          action === "enable" || gatewayAdmin ? [pluginId] : [],
        );
      });
    },
  );
});
