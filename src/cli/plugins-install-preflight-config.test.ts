import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  loadConfigForInstall,
  resolvePluginInstallInvalidConfigPolicy,
  type PluginInstallRequestContext,
} from "../plugins/install-config.js";
import { resolvePluginInstallPreactionRequest } from "./plugin-install-config-policy.js";
import { resolvePluginInstallPreflight } from "./plugins-install-preflight.js";

const mocks = vi.hoisted(() => ({
  bundled: new Map<string, import("../plugins/bundled-sources.js").BundledPluginSource>(),
  snapshot: vi.fn<() => ConfigFileSnapshot>(),
}));

vi.mock("../plugins/bundled-sources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-sources.js")>();
  return {
    ...actual,
    findBundledPluginSource: ({ lookup }: Parameters<typeof actual.findBundledPluginSource>[0]) =>
      actual.findBundledPluginSourceInMap({ bundled: mocks.bundled, lookup }),
    getProcessBundledPluginSources: () => mocks.bundled,
  };
});
vi.mock("../plugins/marketplace.js", () => ({
  resolveMarketplaceInstallShortcut: async () => null,
}));
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: mocks.snapshot(),
    writeOptions: {},
  }),
}));

describe("selected bundled install config recovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(
    ["fixture-recovery", "@fixture/recovery", "@fixture/recovery@1.2.3"].flatMap((raw) =>
      [true, false].flatMap((allowInvalidConfigRecovery) =>
        [false, true].map((sourceCheckout) => ({
          raw,
          allowInvalidConfigRecovery,
          sourceCheckout,
        })),
      ),
    ),
  )(
    "uses selected metadata for $raw (recovery=$allowInvalidConfigRecovery, checkout=$sourceCheckout)",
    async ({ raw, allowInvalidConfigRecovery, sourceCheckout }) => {
      const root = tempDirs.make("plugin-preflight-config-");
      const pluginId = "fixture-recovery";
      const localPath = path.join(root, sourceCheckout ? "dist/extensions" : "bundled", pluginId);
      fs.mkdirSync(localPath, { recursive: true });
      if (sourceCheckout) {
        for (const name of [".git", "src", "extensions"]) {
          fs.mkdirSync(path.join(root, name));
        }
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
        fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      }
      fs.writeFileSync(
        path.join(localPath, "package.json"),
        JSON.stringify({
          name: "@fixture/recovery",
          openclaw: { install: { allowInvalidConfigRecovery } },
        }),
      );
      fs.writeFileSync(
        path.join(localPath, "openclaw.plugin.json"),
        JSON.stringify({ id: pluginId, configSchema: { type: "object", properties: {} } }),
      );
      mocks.bundled.clear();
      mocks.bundled.set(pluginId, { pluginId, localPath, npmSpec: "@fixture/recovery" });
      const config = { channels: { [pluginId]: { token: "preserved" } } };
      const snapshot = createTestConfigSnapshot(config);
      mocks.snapshot.mockReturnValue({
        ...snapshot,
        parsed: config,
        valid: false,
        issues: [{ path: `channels.${pluginId}`, message: `unknown channel id: ${pluginId}` }],
      });

      const selectsBundle = !sourceCheckout || raw === pluginId;
      const allowsRecovery = selectsBundle && allowInvalidConfigRecovery;
      const assertAdmission = async (request: PluginInstallRequestContext | null) => {
        expect(request).not.toBeNull();
        if (!request) {
          throw new Error("Missing install request");
        }
        expect(request.rawSpec).toBe(raw);
        expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe(
          allowsRecovery ? "allow-plugin-recovery" : "deny",
        );
        if (allowsRecovery) {
          await expect(loadConfigForInstall(request)).resolves.toMatchObject({ config });
        } else {
          await expect(loadConfigForInstall(request)).rejects.toThrow("Config invalid");
        }
      };
      const argv = ["node", "openclaw", "plugins", "install", raw];
      const program = new Command();
      program
        .command("plugins")
        .command("install")
        .argument("<spec>")
        .hook("preAction", async (_command, actionCommand) => {
          await assertAdmission(
            resolvePluginInstallPreactionRequest({
              actionCommand,
              commandPath: ["plugins", "install"],
              argv,
            }),
          );
        })
        .action(async () => {
          const preflight = await resolvePluginInstallPreflight({
            raw,
            opts: {},
            allowInstallPolicyWarningPrompt: false,
          });
          expect(preflight.ok).toBe(true);
          if (!preflight.ok) {
            throw new Error(preflight.error);
          }
          expect(preflight.sourcePlan?.request).toEqual(
            selectsBundle
              ? { source: "bundled", pluginId, spec: raw }
              : { source: "npm", spec: raw, mode: "install" },
          );
          await assertAdmission(preflight.request);
        });
      await program.parseAsync(argv);
    },
  );
});
