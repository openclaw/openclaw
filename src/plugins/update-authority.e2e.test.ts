import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseUpdateCommandPreflightForHandoff } from "../cli/update-cli/update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import { isPluginNpmProjectDir, resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import {
  requestDeferredPluginInstall,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { installPluginFromNpmSpec } from "./install.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";
import {
  withUpdater,
  useUpdateControl,
  withPluginState,
  singleInstallConfig,
  pluginInstallRoots,
  snapshotNpmProject,
  acceptCapabilities,
} from "./update-authority.test-support.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const servers: http.Server[] = [];

async function useRegistry(packages: Parameters<typeof startStaticRegistry>[0]) {
  const registry = await startStaticRegistry(packages, servers);
  vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
  vi.stubEnv("npm_config_registry", registry);
}

async function seedPlugin(npmDir: string, name: string, mode?: "update") {
  const result = await installPluginFromNpmSpec({
    npmDir,
    spec: `${name}@1.0.0`,
    timeoutMs: 120_000,
    logger: { info: () => {}, warn: () => {} },
    ...(mode ? { mode } : {}),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

describe("plugin update publication authority", () => {
  it.each([false, true])(
    "handles ClawHub lag with matching npm release available: %s",
    async (published) => {
      await withPluginState("registry-lag", async (state) => {
        const packageName = "@openclaw/codex";
        const versions = await packPlugins(state.path("packages"), [
          { packageName, pluginId: "codex", version: "2026.9.7" },
          { packageName, pluginId: "codex", version: "2026.9.8" },
        ]);
        const requests: string[] = [];
        const clawhub = http.createServer((request, response) => {
          const pathname = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
          requests.push(pathname);
          if (pathname === `/api/v1/packages/${packageName}`) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                package: {
                  name: packageName,
                  family: "code-plugin",
                  channel: "official",
                  isOfficial: true,
                  latestVersion: "2026.9.7",
                },
              }),
            );
          } else {
            response.writeHead(404);
            response.end("Version not found");
          }
        });
        await new Promise<void>((resolve) => {
          clawhub.listen(0, "127.0.0.1", resolve);
        });
        servers.push(clawhub);
        const address = clawhub.address();
        if (!address || typeof address === "string") {
          throw new Error("ClawHub fixture has no loopback port");
        }
        vi.stubEnv("OPENCLAW_CLAWHUB_URL", `http://127.0.0.1:${address.port}`);
        const extensionsDir = state.statePath("extensions");
        const installPath = path.join(extensionsDir, "codex");
        await fs.cp(
          path.join(state.path("packages"), `package-${packageName}-2026.9.7`),
          installPath,
          { recursive: true },
        );
        const oldPayload = await fs.readFile(path.join(installPath, "dist/index.js"));
        const config = singleInstallConfig(
          "codex",
          {
            source: "clawhub",
            spec: `clawhub:${packageName}`,
            installPath,
            version: "2026.9.7",
          },
          { entries: { codex: { enabled: true, config: { preserved: true } } } },
        );
        await withPluginInstallRoots(pluginInstallRoots(state), async () => {
          await useRegistry([
            {
              packageName,
              latest: published ? "2026.9.8" : "2026.9.7",
              versions: published ? versions : versions.slice(0, 1),
            },
          ]);
          const result = await convergePluginReleaseCohort({
            config,
            channel: "stable",
            coreVersion: "2026.9.8",
            versionBoundPluginIds: new Set(["codex"]),
            timeoutMs: 120_000,
            env: state.env,
            workspaceDir: state.root,
            onCapabilityConsent: acceptCapabilities,
          });
          expect(result.config.plugins?.entries?.codex).toEqual(config.plugins?.entries?.codex);
          expect(result.remainingMissingPayloads).toEqual([]);
          const record = expectDefined(result.config.plugins?.installs?.codex, "converged plugin");
          if (published) {
            expect(record).toMatchObject({ source: "npm", version: "2026.9.8" });
            expect(
              JSON.parse(await fs.readFile(path.join(record.installPath!, "package.json"), "utf8")),
            ).toMatchObject({ name: packageName, version: "2026.9.8" });
          } else {
            expect(record).toEqual(config.plugins?.installs?.codex);
            expect(result.updateOutcomes).toContainEqual(
              expect.objectContaining({ code: "plugin-target-unavailable", status: "unchanged" }),
            );
            expect(await fs.readFile(path.join(installPath, "dist/index.js"))).toEqual(oldPayload);
          }
        });
        expect(requests).toContain(`/api/v1/packages/${packageName}/versions/2026.9.8`);
      });
    },
  );

  it.each(["commit", "rollback"] as const)(
    "keeps retained settlement bound to its initiating updater with %s first",
    { timeout: 180_000 },
    async (firstAction) => {
      await withPluginState(`retained-updater-${firstAction}`, async (state) => {
        const packageName = `retained-owner-${crypto.randomUUID()}`;
        const versions = await packPlugins(state.path("packages"), [{ packageName }]);
        await useRegistry([{ packageName, latest: "1.0.0", versions }]);
        const npmDir = state.statePath("npm");
        await useUpdateControl(state);
        await withPluginInstallRoots(pluginInstallRoots(state), async () => {
          const recover = await withPluginLifecycleLease({ env: state.env }, async (rawLease) => {
            const legacy = await seedPlugin(npmDir, packageName, "update");
            const generation = await seedPlugin(npmDir, packageName, "update");
            expect(generation.targetDir).not.toBe(legacy.targetDir);
            const projectRoot = path.dirname(path.dirname(generation.targetDir));
            expect(isPluginNpmProjectDir({ packageName, projectDir: projectRoot, npmDir })).toBe(
              true,
            );
            const backupRoot = path.join(path.dirname(projectRoot), ".openclaw-install-backups");
            const readBackups = async () => {
              try {
                return (await fs.readdir(backupRoot)).toSorted();
              } catch (error) {
                if (isNotFoundPathError(error)) {
                  return [];
                }
                throw error;
              }
            };
            const readProject = (root: string) =>
              snapshotNpmProject(root, path.join(root, "node_modules", packageName));
            const seeded = await readProject(projectRoot);
            expect(await readBackups()).toEqual([]);
            // Omit resolved metadata to force replacement instead of the unchanged shortcut.
            const config = singleInstallConfig(packageName, {
              source: "npm",
              spec: packageName,
              installPath: generation.targetDir,
              version: "1.0.0",
            });
            const installDeferred = async (sink: PluginInstallTransaction[]) => {
              // The updater lease is the only authority source; no request assertion.
              const result = await updateNpmInstalledPlugins(
                requestDeferredPluginInstall(
                  { config, timeoutMs: 120_000, onCapabilityConsent: acceptCapabilities },
                  sink,
                ),
              );
              expect(result.outcomes).toEqual([
                expect.objectContaining({
                  pluginId: packageName,
                  status: "unchanged",
                  currentVersion: "1.0.0",
                  nextVersion: "1.0.0",
                }),
              ]);
              expect(result.config.plugins?.installs?.[packageName]?.installPath).toBe(
                generation.targetDir,
              );
              expect(sink).toHaveLength(1);
              return expectDefined(sink[0], "retained plugin install transaction");
            };

            return await withUpdater(state, true, async (oldFence) => {
              const oldTransaction = await withPluginLifecycleLease(
                { assertCurrent: oldFence.assertCurrent },
                () => installDeferred([]),
              );
              const retainedBackups = await readBackups();
              expect(retainedBackups).toHaveLength(1);
              const oldBackup = path.join(
                backupRoot,
                expectDefined(retainedBackups[0], "retained backup"),
              );
              expect(await readProject(oldBackup)).toEqual(seeded);
              const snapshot = async () => ({
                live: await readProject(projectRoot),
                backup: await readProject(oldBackup),
                backups: await readBackups(),
              });
              const retained = await snapshot();
              expect(retained.live.identities).not.toEqual(retained.backup.identities);
              releaseUpdateCommandPreflightForHandoff(oldFence);
              expect(oldFence.assertCurrent).toThrow(UpdateCommandRecoveryPendingError);
              rawLease.assertOwned();
              expect(rawLease.signal.aborted).toBe(false);

              await withUpdater(state, false, async (freshFence) => {
                await withPluginLifecycleLease(
                  { assertCurrent: freshFence.assertCurrent },
                  async () => {
                    // A fresh updater cannot revive the retained transaction or its lease.
                    const secondAction = firstAction === "commit" ? "rollback" : "commit";
                    for (const action of [firstAction, secondAction] as const) {
                      await expect(oldTransaction[action]()).rejects.toThrow(
                        UpdateCommandRecoveryPendingError,
                      );
                      expect(await snapshot()).toEqual(retained);
                      expect(() => rawLease.assertOwned()).toThrow(
                        UpdateCommandRecoveryPendingError,
                      );
                      expect(rawLease.signal.aborted).toBe(false);
                    }
                    freshFence.assertCurrent();
                  },
                );
              });
              return async () => {
                await withPluginLifecycleLease({ env: state.env }, async (freshLease) => {
                  await withUpdater(state, false, async (freshFence) => {
                    await withPluginLifecycleLease(
                      { assertCurrent: freshFence.assertCurrent },
                      async () => {
                        const secondAction = firstAction === "commit" ? "rollback" : "commit";
                        for (const action of [firstAction, secondAction] as const) {
                          await expect(oldTransaction[action]()).rejects.toThrow(
                            UpdateCommandRecoveryPendingError,
                          );
                          expect(await snapshot()).toEqual(retained);
                          freshFence.assertCurrent();
                          freshLease.assertOwned();
                        }
                        const freshTransaction = await installDeferred([]);
                        const freshBackups = (await readBackups()).filter(
                          (name) => !retainedBackups.includes(name),
                        );
                        expect(freshBackups).toHaveLength(1);
                        const freshBackup = path.join(
                          backupRoot,
                          expectDefined(freshBackups[0], "fresh backup"),
                        );
                        expect(await readProject(freshBackup)).toEqual(retained.live);
                        const freshLive = await readProject(projectRoot);
                        expect(freshLive.identities).not.toEqual(retained.live.identities);
                        await freshTransaction[firstAction]();
                        expect(await readProject(projectRoot)).toEqual(
                          firstAction === "commit" ? freshLive : retained.live,
                        );
                        expect(await readBackups()).toEqual(retainedBackups);
                        expect(await readProject(oldBackup)).toEqual(retained.backup);
                        freshFence.assertCurrent();
                        freshLease.assertOwned();
                        expect(freshLease.signal.aborted).toBe(false);
                      },
                    );
                  });
                });
              };
            });
          });
          // Recover after the revoked lease closes; retained handles must stay revoked.
          await recover();
        });
      });
    },
  );

  it.each(["bridge", "installed"] as const)(
    "keeps the old %s package when updater authority closes after consent",
    { timeout: 180_000 },
    async (route) => {
      await withPluginState(`cohort-publication-${route}`, async (state) => {
        const packageName = `cohort-owner-${crypto.randomUUID()}`;
        const versions = await packPlugins(state.path("packages"), [
          { packageName, version: "1.0.0", manifest: { providers: ["existing-provider"] } },
          {
            packageName,
            version: "2.0.0",
            manifest: { providers: ["existing-provider", "new-provider"] },
          },
        ]);
        await useRegistry([{ packageName, latest: "2.0.0", versions }]);
        const npmRoot = state.statePath("npm");
        const roots = pluginInstallRoots(state);
        const installed = await seedPlugin(npmRoot, packageName);

        const projectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
        const projectsDir = path.dirname(projectRoot);
        const readPublishedProjects = async () =>
          (await fs.readdir(projectsDir))
            .filter((name) =>
              isPluginNpmProjectDir({
                packageName,
                projectDir: path.join(projectsDir, name),
                npmDir: npmRoot,
              }),
            )
            .toSorted();

        const original = await snapshotNpmProject(projectRoot, installed.targetDir);

        const bundledPath = state.path("old", "extensions", packageName);
        const config = singleInstallConfig(
          packageName,
          route === "bridge"
            ? { source: "path", sourcePath: bundledPath, installPath: bundledPath }
            : {
                source: "npm",
                spec: packageName,
                installPath: installed.targetDir,
                version: "1.0.0",
              },
          {
            entries: { [packageName]: { enabled: true } },
            ...(route === "bridge" ? { load: { paths: [bundledPath] } } : {}),
          },
        );
        await useUpdateControl(state);

        for (const revoke of [true, false]) {
          await withUpdater(state, true, async (fence) => {
            let consented = false;
            let publicationProbeReached = false;
            let publishedProjectsAtRevocation: string[] | undefined;
            const realpath = fs.realpath;
            const probe = vi
              .spyOn(fs, "realpath")
              .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
                const result = await realpath(...args);
                if (
                  consented &&
                  !publicationProbeReached &&
                  String(args[0]) === path.dirname(projectRoot)
                ) {
                  publicationProbeReached = true;
                  fence.assertCurrent();
                  if (revoke) {
                    // Revoke at publication's await; snapshot only canonical projects, not staging.
                    publishedProjectsAtRevocation = await readPublishedProjects();
                    fence.assertCurrent();
                    releaseUpdateCommandPreflightForHandoff(fence);
                    expect(fence.assertCurrent).toThrow();
                  }
                }
                return result;
              });
            try {
              const operation = withPluginInstallRoots(roots, () =>
                convergePluginReleaseCohort({
                  config,
                  channel: "stable",
                  timeoutMs: 120_000,
                  env: state.env,
                  workspaceDir: state.root,
                  beforePersistentEffect: fence.assertCurrent,
                  ...(route === "bridge"
                    ? {
                        externalizedBundledPluginBridges: [
                          { bundledPluginId: packageName, npmSpec: packageName },
                        ],
                      }
                    : {}),
                  onCapabilityConsent: async (review) => {
                    consented = true;
                    return { reviewToken: review.reviewToken };
                  },
                }),
              );
              if (revoke) {
                await expect(operation).rejects.toThrow("ownership is no longer current");
                expect(publishedProjectsAtRevocation).toBeDefined();
                expect(await readPublishedProjects()).toEqual(publishedProjectsAtRevocation);
                expect(await snapshotNpmProject(projectRoot, installed.targetDir)).toEqual(
                  original,
                );
              } else {
                const result = await operation;
                const record = result.config.plugins?.installs?.[packageName];
                expect(record?.version).toBe("2.0.0");
                expect(result.remainingMissingPayloads).toEqual([]);
                if (!record?.installPath) {
                  throw new Error("updated install record has no active path");
                }
                expect(
                  JSON.parse(
                    await fs.readFile(path.join(record.installPath, "package.json"), "utf8"),
                  ),
                ).toMatchObject({ version: "2.0.0" });
              }
              expect(consented).toBe(true);
              expect(publicationProbeReached).toBe(true);
            } finally {
              probe.mockRestore();
            }
          });
        }
      });
    },
  );
});
