import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseUpdateCommandPreflightForHandoff } from "../cli/update-cli/update-command-executor.js";
import * as installMetadata from "../infra/install-source-utils.js";
import * as clawhub from "./clawhub.js";
import * as installer from "./install.js";
import * as catalog from "./official-external-plugin-catalog.js";
import { installableEntry } from "./official-external-plugin-catalog.test-support.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";
import {
  withUpdater,
  useUpdateControl,
  withPluginState,
  singleInstallConfig,
} from "./update-authority.test-support.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe("plugin update authority", () => {
  it.each([
    ["untrusted", "version_not_found"],
    ["blocked", "clawhub_download_blocked"],
    ["integrity", "archive_integrity_mismatch"],
    ["catalog-behind", "version_not_found"],
    ["newer-pin", "version_not_found"],
  ] as const)("does not use npm to bypass a ClawHub %s refusal", async (reason, code) => {
    await withPluginState("update-source-authority", async (state) => {
      const installPath = state.statePath("extensions", "codex");
      const installedVersion = reason === "newer-pin" ? "2026.9.9" : "2026.9.7";
      await state.writeJson("extensions/codex/package.json", {
        name: "@openclaw/codex",
        version: installedVersion,
        openclaw: { extensions: ["./index.js"] },
      });
      const payload = "export default function register() {}\n";
      await state.writeText("extensions/codex/index.js", payload);
      const config = singleInstallConfig(
        "codex",
        {
          source: "clawhub" as const,
          spec:
            reason === "newer-pin" ? "clawhub:@openclaw/codex@2026.9.9" : "clawhub:@openclaw/codex",
          clawhubPackage: "@openclaw/codex",
          clawhubChannel: "official" as const,
          clawhubUrl: reason === "untrusted" ? "https://registry.example" : "https://clawhub.ai",
          installPath,
          version: installedVersion,
        },
        { entries: { codex: { enabled: true } } },
      );
      if (reason === "catalog-behind") {
        const entry = installableEntry("@openclaw/codex", {
          sourceRef: "public-npm",
          package: "@openclaw/codex",
          version: "2026.9.7",
        });
        entry.openclaw = { plugin: { id: "codex" } };
        const getEntry = catalog.getOfficialExternalPluginCatalogEntry;
        vi.spyOn(catalog, "getOfficialExternalPluginCatalogEntry").mockImplementation((id) =>
          id === "codex" ? entry : getEntry(id),
        );
      }
      vi.spyOn(clawhub, "installPluginFromClawHub").mockResolvedValue({
        ok: false,
        code,
        version: reason === "newer-pin" ? "2026.9.9" : "2026.9.8",
        error: reason,
      });
      const npm = vi
        .spyOn(installer, "installPluginFromNpmSpec")
        .mockRejectedValue(new Error("unexpected source switch"));
      const result = await updateNpmInstalledPlugins({
        config,
        coreVersion: "2026.9.8",
        updateChannel: "stable",
        versionBoundPluginIds: new Set(["codex"]),
        retainOnUnavailable: true,
      });
      expect(npm).not.toHaveBeenCalled();
      if (reason === "newer-pin" || reason === "catalog-behind") {
        expect(clawhub.installPluginFromClawHub).toHaveBeenCalledWith(
          expect.objectContaining({
            spec: `clawhub:@openclaw/codex@${reason === "newer-pin" ? "2026.9.9" : "2026.9.8"}`,
          }),
        );
      }
      if (reason === "catalog-behind") {
        expect(result.outcomes[0]).toMatchObject({
          status: "unchanged",
          code: "plugin-target-unavailable",
        });
      }
      expect(result.config).toBe(config);
      expect(await fs.readFile(path.join(installPath, "index.js"), "utf8")).toBe(payload);
    });
  });

  it("keeps dry-run checks free of lifecycle lease writes", async () => {
    await withPluginState("plugin-update-dry-run", async (state) => {
      const before = await fs.readdir(state.stateDir);
      expect(await updateNpmInstalledPlugins({ config: {}, dryRun: true })).toMatchObject({
        changed: false,
        outcomes: [],
      });
      expect(await fs.readdir(state.stateDir)).toEqual(before);
    });
  });

  it("stops unchanged-package host repair after revocation and lets a fresh updater finish", async () => {
    await withPluginState("plugin-update-host-owner", async (state) => {
      const pluginId = "registered-peer";
      const packageDir = state.statePath("extensions", pluginId);
      const peerLink = path.join(packageDir, "node_modules", "openclaw");
      const oldHost = state.path("old-host");
      await fs.mkdir(path.dirname(peerLink), { recursive: true });
      await fs.mkdir(oldHost);
      await fs.writeFile(
        path.join(oldHost, "package.json"),
        '{"name":"openclaw","version":"0.0.0"}',
      );
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: pluginId, version: "1.0.0", peerDependencies: { openclaw: "*" } }),
      );
      await fs.symlink(oldHost, peerLink, "junction");
      const config = singleInstallConfig(pluginId, {
        source: "npm" as const,
        spec: `${pluginId}@1.0.0`,
        installPath: packageDir,
        resolvedName: pluginId,
        resolvedSpec: `${pluginId}@1.0.0`,
        resolvedVersion: "1.0.0",
      });
      await useUpdateControl(state);
      vi.spyOn(installMetadata, "resolveNpmSpecMetadata").mockResolvedValue({
        ok: true,
        metadata: { name: pluginId, version: "1.0.0", resolvedSpec: `${pluginId}@1.0.0` },
      });
      for (const revoke of [true, false]) {
        await withUpdater(state, true, async (fence) => {
          let unlinked = false;
          const unlink = fsSync.unlinkSync.bind(fsSync);
          const removal = vi.spyOn(fsSync, "unlinkSync").mockImplementation((file) => {
            unlink(file);
            if (String(file) === peerLink && revoke) {
              unlinked = true;
              releaseUpdateCommandPreflightForHandoff(fence);
            }
          });
          syncBuiltinESMExports();
          try {
            const operation = withPluginLifecycleLease(
              { env: state.env, assertCurrent: fence.assertCurrent },
              () => updateNpmInstalledPlugins({ config }),
            );
            if (revoke) {
              await expect(operation).rejects.toThrow("ownership is no longer current");
              expect(unlinked).toBe(true);
              await expect(fs.lstat(peerLink)).rejects.toHaveProperty("code", "ENOENT");
            } else {
              expect((await operation).outcomes).toMatchObject([{ status: "unchanged" }]);
              expect(
                await auditDeclaredOpenClawHostDependency({ packageDir, packageName: pluginId }),
              ).toBeNull();
              expect(await fs.realpath(peerLink)).not.toBe(oldHost);
            }
          } finally {
            removal.mockRestore();
            syncBuiltinESMExports();
          }
        });
      }
    });
  });
});
