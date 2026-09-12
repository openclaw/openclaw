import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import { isPluginNpmProjectDir, resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import {
  requestDeferredPluginInstall,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { installPluginFromNpmSpec } from "./install.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const servers: http.Server[] = [];

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
  it.each(["commit", "rollback"] as const)(
    "keeps retained settlement bound to its initiating updater with %s first",
    { timeout: 180_000 },
    async (firstAction) => {
      await withOpenClawTestState(
        {
          label: `retained-updater-${firstAction}`,
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const packageName = `retained-owner-${crypto.randomUUID()}`;
          const versions = await packPlugins(state.path("packages"), [{ packageName }]);
          const registry = await startStaticRegistry(
            [{ packageName, latest: "1.0.0", versions }],
            servers,
          );
          vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
          vi.stubEnv("npm_config_registry", registry);
          const npmDir = state.statePath("npm");
          const roots = {
            npmDir,
            extensionsDir: state.statePath("extensions"),
            gitDir: state.statePath("git"),
            stateDir: state.stateDir,
          };
          const control = state.path("control");
          await fs.mkdir(control);
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          await withPluginInstallRoots(roots, () =>
            withPluginLifecycleLease({ env: state.env }, async (rawLease) => {
              const seed = async () => {
                const result = await installPluginFromNpmSpec({
                  npmDir,
                  spec: `${packageName}@1.0.0`,
                  mode: "update",
                  logger: { info: () => {}, warn: () => {} },
                  timeoutMs: 120_000,
                });
                if (!result.ok) {
                  throw new Error(result.error);
                }
                return result;
              };
              const legacy = await seed();
              const generation = await seed();
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
              const readProject = async (root: string) => {
                const packageRoot = path.join(root, "node_modules", packageName);
                const identities = await Promise.all(
                  [root, packageRoot].map(async (dir) => {
                    const stat = await fs.lstat(dir, { bigint: true });
                    expect(stat.isDirectory()).toBe(true);
                    return [stat.dev, stat.ino];
                  }),
                );
                const files = await Promise.all(
                  [
                    path.join(root, "package.json"),
                    path.join(root, "package-lock.json"),
                    path.join(packageRoot, "package.json"),
                    path.join(packageRoot, "openclaw.plugin.json"),
                    path.join(packageRoot, "dist", "index.js"),
                  ].map((file) => fs.readFile(file)),
                );
                return { identities, files };
              };
              const seeded = await readProject(projectRoot);
              const initialBackups = await readBackups();
              expect(initialBackups).toEqual([]);
              // Omit resolved metadata on both attempts so the real installer
              // replaces this same generation instead of taking the unchanged shortcut.
              const config: OpenClawConfig = {
                plugins: {
                  installs: {
                    [packageName]: {
                      source: "npm",
                      spec: packageName,
                      installPath: generation.targetDir,
                      version: "1.0.0",
                    },
                  },
                },
              };
              const installDeferred = async (sink: PluginInstallTransaction[]) => {
                const onCapabilityConsent: PluginCapabilityConsentHandler = async (review) => ({
                  reviewToken: review.reviewToken,
                });
                // The updater lease is the only authority source; no request assertion.
                const result = await updateNpmInstalledPlugins(
                  requestDeferredPluginInstall(
                    { config, timeoutMs: 120_000, onCapabilityConsent },
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
              const oldRun = createUpdateRun({ trigger: "cli" }, { env: state.env });
              await withUpdateCommandExecutor(oldRun.runId, async (oldExecutor) => {
                const oldFence = await oldExecutor.enter(state.root, { preflight: true });
                const oldTransaction = await withPluginLifecycleLease(
                  { assertCurrent: oldFence.assertCurrent },
                  () => installDeferred([]),
                );
                const retainedBackups = await readBackups();
                expect(retainedBackups).toHaveLength(1);
                const oldBackup = path.join(
                  backupRoot,
                  expectDefined(retainedBackups[0], "retained plugin install backup"),
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

                const freshRun = createUpdateRun({ trigger: "cli" }, { env: state.env });
                await withUpdateCommandExecutor(freshRun.runId, async (freshExecutor) => {
                  const freshFence = await freshExecutor.enter(state.root);
                  await withPluginLifecycleLease(
                    { assertCurrent: freshFence.assertCurrent },
                    async () => {
                      // First touch of the retained handle is under a new genuine
                      // updater: ambient ownership must not revive the captured one.
                      const secondAction = firstAction === "commit" ? "rollback" : "commit";
                      for (const action of [firstAction, secondAction] as const) {
                        await expect(oldTransaction[action]()).rejects.toThrow(
                          UpdateCommandRecoveryPendingError,
                        );
                        expect(await snapshot()).toEqual(retained);
                        rawLease.assertOwned();
                        expect(rawLease.signal.aborted).toBe(false);
                      }
                      const freshTransaction = await installDeferred([]);
                      const freshBackups = (await readBackups()).filter(
                        (name) => !retainedBackups.includes(name),
                      );
                      expect(freshBackups).toHaveLength(1);
                      const freshBackup = path.join(
                        backupRoot,
                        expectDefined(freshBackups[0], "fresh plugin install backup"),
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
                      rawLease.assertOwned();
                      expect(rawLease.signal.aborted).toBe(false);
                    },
                  );
                });
              });
            }),
          );
        },
      );
    },
  );

  it.each(["bridge", "installed"] as const)(
    "keeps the old %s package when updater authority closes after consent",
    { timeout: 180_000 },
    async (route) => {
      await withOpenClawTestState(
        { label: `cohort-publication-${route}`, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const packageName = `cohort-owner-${crypto.randomUUID()}`;
          const versions = await packPlugins(state.path("packages"), [
            { packageName, version: "1.0.0", manifest: { providers: ["existing-provider"] } },
            {
              packageName,
              version: "2.0.0",
              manifest: { providers: ["existing-provider", "new-provider"] },
            },
          ]);
          const registry = await startStaticRegistry(
            [{ packageName, latest: "2.0.0", versions }],
            servers,
          );
          vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
          vi.stubEnv("npm_config_registry", registry);
          const npmRoot = state.statePath("npm");
          const roots = {
            npmDir: npmRoot,
            extensionsDir: state.statePath("extensions"),
            gitDir: state.statePath("git"),
            stateDir: state.stateDir,
          };
          const installed = await installPluginFromNpmSpec({
            npmDir: npmRoot,
            spec: `${packageName}@1.0.0`,
            logger: { info: () => {}, warn: () => {} },
            timeoutMs: 120_000,
          });
          if (!installed.ok) {
            throw new Error(installed.error);
          }
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
          const protectedFiles = [
            path.join(projectRoot, "package.json"),
            path.join(projectRoot, "package-lock.json"),
            path.join(installed.targetDir, "package.json"),
            path.join(installed.targetDir, "dist", "index.js"),
          ];
          const original = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
          const originalIdentity = await fs.stat(projectRoot);
          const bundledPath = state.path("old", "extensions", packageName);
          const config: OpenClawConfig = {
            plugins: {
              entries: { [packageName]: { enabled: true } },
              ...(route === "bridge" ? { load: { paths: [bundledPath] } } : {}),
              installs: {
                [packageName]:
                  route === "bridge"
                    ? { source: "path", sourcePath: bundledPath, installPath: bundledPath }
                    : {
                        source: "npm",
                        spec: packageName,
                        installPath: installed.targetDir,
                        version: "1.0.0",
                      },
              },
            },
          };
          const control = state.path("control");
          await fs.mkdir(control);
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);

          for (const revoke of [true, false]) {
            const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
            await withUpdateCommandExecutor(run.runId, async (executor) => {
              const fence = await executor.enter(state.root, { preflight: true });
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
                      // Close authority after consent at the publication owner's
                      // filesystem await. Exclude existing private staging from
                      // the canonical project snapshot across that boundary.
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
                  expect(
                    await Promise.all(protectedFiles.map((file) => fs.readFile(file))),
                  ).toEqual(original);
                  const currentIdentity = await fs.stat(projectRoot);
                  expect([currentIdentity.dev, currentIdentity.ino]).toEqual([
                    originalIdentity.dev,
                    originalIdentity.ino,
                  ]);
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
        },
      );
    },
  );
});
