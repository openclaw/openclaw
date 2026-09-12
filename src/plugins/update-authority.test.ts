import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import * as installMetadata from "../infra/install-source-utils.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

afterEach(() => vi.restoreAllMocks());

describe("plugin update authority", () => {
  it("keeps dry-run checks free of lifecycle lease writes", async () => {
    await withOpenClawTestState(
      { label: "plugin-update-dry-run", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const before = await fs.readdir(state.stateDir);
        expect(await updateNpmInstalledPlugins({ config: {}, dryRun: true })).toMatchObject({
          changed: false,
          outcomes: [],
        });
        expect(await fs.readdir(state.stateDir)).toEqual(before);
      },
    );
  });

  it("stops unchanged-package host repair after revocation and lets a fresh updater finish", async () => {
    await withOpenClawTestState(
      { label: "plugin-update-host-owner", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginId = "registered-peer";
        const packageDir = state.statePath("extensions", pluginId);
        const peerLink = path.join(packageDir, "node_modules", "openclaw");
        const oldHost = state.path("old-host");
        const control = state.path("control");
        await fs.mkdir(path.dirname(peerLink), { recursive: true });
        await fs.mkdir(oldHost);
        await fs.mkdir(control);
        await fs.writeFile(
          path.join(oldHost, "package.json"),
          '{"name":"openclaw","version":"0.0.0"}',
        );
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: pluginId, version: "1.0.0", peerDependencies: { openclaw: "*" } }),
        );
        await fs.symlink(oldHost, peerLink, "junction");
        const config = {
          plugins: {
            installs: {
              [pluginId]: {
                source: "npm" as const,
                spec: `${pluginId}@1.0.0`,
                installPath: packageDir,
                resolvedName: pluginId,
                resolvedSpec: `${pluginId}@1.0.0`,
                resolvedVersion: "1.0.0",
              },
            },
          },
        };
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        vi.spyOn(installMetadata, "resolveNpmSpecMetadata").mockResolvedValue({
          ok: true,
          metadata: { name: pluginId, version: "1.0.0", resolvedSpec: `${pluginId}@1.0.0` },
        });
        for (const revoke of [true, false]) {
          const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
          await withUpdateCommandExecutor(run.runId, async (executor) => {
            const fence = await executor.enter(state.root, { preflight: true });
            let unlinked = false;
            const unlink = fs.unlink;
            const removal = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
              await unlink(file);
              if (String(file) === peerLink && revoke) {
                unlinked = true;
                releaseUpdateCommandPreflightForHandoff(fence);
              }
            });
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
            }
          });
        }
      },
    );
  });
});
