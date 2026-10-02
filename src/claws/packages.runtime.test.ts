import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { installClawPackages, preflightClawPackage } from "./packages.js";
import { emptyPluginCapabilityEvidence, packageInstallPlan } from "./packages.test-support.js";

const installOwner = vi.hoisted(() => ({
  install: vi.fn(),
  failure: new Error("artifact owner rejected the installation"),
}));
vi.mock("../plugins/management-mutations.js", () => ({
  installManagedPlugin: installOwner.install,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const integrity = `sha256:${"a".repeat(64)}`;
type InstallOptions = NonNullable<Parameters<typeof installClawPackages>[1]>;

function packageDeps(
  root: string,
  loadInstallRecords: () => Promise<Record<string, PluginInstallRecord>>,
) {
  return {
    preflightPlugin: (params) => preflightPluginInstall({ ...params, loadInstallRecords }),
    probePlugin: async (request) => {
      const { spec } = request;
      const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
      await request.onPluginArtifactInspect?.({
        pluginId,
        stagedArtifactDir: root,
        mode: "install",
      });
      return {
        ok: true,
        packageName: spec,
        pluginId,
        targetDir: root,
        extensions: [],
        clawhub: {
          source: "clawhub",
          clawhubFamily: "code-plugin",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: spec,
          integrity,
        },
      };
    },
    inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
    persistPackageRef: (plan, pkg, persistOptions) => ({
      schemaVersion: "openclaw.clawPackageRef.v1",
      agentId: plan.agent.finalId,
      clawName: plan.claw.name,
      kind: pkg.kind,
      source: pkg.source,
      ref: pkg.ref,
      version: pkg.version!,
      integrity: pkg.integrity!,
      status: persistOptions?.status ?? "pending",
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      installedAtMs: 1,
      updatedAtMs: 1,
    }),
    completePackageRef: (ref, status) => ({ ...ref, status }),
  } satisfies InstallOptions["deps"];
}

describe("Claw committed plugin requirement handoff", () => {
  it("preserves the install owner's failure instead of a nested CLI exit", async () => {
    const root = dirs.make("openclaw-claw-install-error-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    installOwner.install.mockReset().mockRejectedValue(installOwner.failure);
    await withEnvAsync(env, async () => {
      const result = await installClawPackages(
        packageInstallPlan([
          { kind: "plugin", source: "clawhub", ref: "@owner/demo", version: "1.0.0", integrity },
        ]),
        {
          env,
          pluginConsent: {
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          },
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected outer exit");
            },
          },
          deps: {
            ...packageDeps(root, async () => ({})),
            acquirePackageLease: () => ({ heartbeat: () => {}, release: () => {} }),
          },
        },
      ).catch((error: unknown) => error);
      expect(installOwner.install).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        code: "package_install_failed",
        message: installOwner.failure.message,
        cause: installOwner.failure,
      });
    });
  });
  it.each([false, true])(
    "applies retained writes once after lease release (late failure=%s)",
    async (lateFailure) => {
      const root = dirs.make("openclaw-claw-runtime-");
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
      await withEnvAsync(env, async () => {
        let records: Record<string, PluginInstallRecord> = {};
        let heldPackages = 0;
        const cleanup = vi.fn();
        const log = vi.fn();
        const reloadPlugins = vi.fn<PluginInstallBatchReload>(async (targets) => {
          expect(hasPluginLifecycleLease()).toBe(false);
          expect(heldPackages).toBe(0);
          expect(cleanup).not.toHaveBeenCalled();
          expect(targets.map((target: { pluginId: string }) => target.pluginId)).toEqual(
            lateFailure ? ["first"] : ["first", "second"],
          );
          return {
            operationId: "batch",
            generation: 2,
            pluginIds: targets.map((target: { pluginId: string }) => target.pluginId),
            warnings: ["Previous plugin cleanup did not finish."],
          };
        });
        const options: InstallOptions = {
          env,
          pluginConsent: {
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          },
          runtime: {
            log,
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          reloadPlugins,
          deps: {
            ...packageDeps(root, async () => records),
            acquirePackageLease: () => {
              heldPackages++;
              return {
                heartbeat: () => true,
                release: () => {
                  heldPackages--;
                },
              };
            },
            installPlugin: async (params) => {
              if (params.request.source !== "clawhub" || !params.request.expectedPluginId) {
                throw new Error("Expected a pinned ClawHub plugin request");
              }
              const pluginId = params.request.expectedPluginId;
              const next = {
                ...records,
                [pluginId]: {
                  source: "clawhub" as const,
                  clawhubPackage: `@owner/${pluginId}`,
                  version: "1.0.0",
                  integrity,
                  installPath: path.join(root, "plugins", pluginId),
                },
              };
              const write = await commitPluginInstallRecordsWithConfig({
                previousInstallRecords: records,
                nextInstallRecords: next,
                nextConfig: {},
                writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
              });
              records = next;
              params.deferRuntime?.record({
                operation: "install",
                pluginId,
                sourceDigests: {},
                write,
              });
              params.deferRuntime?.deferCleanup(
                async (assertOwned, warn) => {
                  assertOwned();
                  cleanup(pluginId);
                  warn(`Source cleanup warning for ${pluginId}`);
                },
                path.join(root, "retired", pluginId),
              );
              if (lateFailure) {
                throw new Error("postcommit metadata failure");
              }
            },
          },
        };
        const plan = packageInstallPlan(
          ["first", "second"].map((id) => ({
            kind: "plugin",
            source: "clawhub",
            ref: `@owner/${id}`,
            version: "1.0.0",
            integrity,
          })),
        );
        const pending = installClawPackages(plan, options);
        let completed: Awaited<typeof pending> | undefined;
        if (lateFailure) {
          await expect(pending).rejects.toMatchObject({
            code: "package_install_failed",
            message: "postcommit metadata failure",
          });
        } else {
          completed = await pending;
          expect(completed).toHaveLength(2);
        }
        expect(reloadPlugins).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith("Previous plugin cleanup did not finish.");
        expect(cleanup).toHaveBeenCalledTimes(lateFailure ? 1 : 2);
        expect(log).toHaveBeenCalledWith("Source cleanup warning for first");
        if (completed) {
          const installedRefs = completed;
          cleanup.mockClear();
          const installPlugin = vi.fn(async () => {
            throw new Error("resumed requirement was reinstalled");
          });
          const resumedOptions = {
            ...options,
            deps: {
              ...options.deps,
              installPlugin,
              readPackageRefs: () => installedRefs,
            },
          };
          reloadPlugins.mockRejectedValueOnce(new Error("runtime reply lost"));
          await expect(installClawPackages(plan, resumedOptions)).rejects.toMatchObject({
            code: "package_runtime_failed",
            message: expect.stringContaining("Runtime activation was not confirmed"),
          });
          await expect(installClawPackages(plan, resumedOptions)).resolves.toHaveLength(2);
          expect(installPlugin).not.toHaveBeenCalled();
          expect(cleanup).not.toHaveBeenCalled();
          expect(reloadPlugins).toHaveBeenCalledTimes(3);
        }
      });
    },
  );
});

describe("Claw source-host plugin collision", () => {
  const pinnedLobster = {
    kind: "plugin",
    source: "clawhub",
    ref: "@openclaw/lobster",
    version: "2026.7.1",
    integrity,
  } as const;
  const preflightPlugin = vi.fn(async () => ({
    ok: true as const,
    action: "install" as const,
    request: {} as never,
  }));
  const probePlugin = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
    await request.onPluginArtifactInspect?.({
      pluginId: "lobster",
      stagedArtifactDir: path.join(process.cwd(), "extensions", "lobster"),
      mode: "install",
    });
    return {
      ok: true as const,
      pluginId: "lobster",
      packageName: pinnedLobster.ref,
      targetDir: "/tmp/lobster",
      extensions: [],
      artifactInspection: { format: "openclaw" as const, mapped: ["plugin"], unavailable: [] },
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: pinnedLobster.ref,
        clawhubFamily: "code-plugin" as const,
        integrity,
      },
    };
  });

  function sourceHostEnv(root: string): NodeJS.ProcessEnv {
    return {
      OPENCLAW_DEV_SOURCE_ROOT: process.cwd(),
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
  }

  it("blocks the pinned ClawHub plugin before installation", async () => {
    const root = dirs.make("claw-source-plugin-conflict-");
    const env = sourceHostEnv(root);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}");
    await withEnvAsync(env, async () => {
      await expect(
        preflightClawPackage(pinnedLobster, path.join(root, "workspace"), {
          config: {},
          env,
          deps: {
            preflightPlugin,
            probePlugin,
            inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "plugin_source_host_conflict",
        message: expect.stringContaining("bundled plugin lobster"),
      });
    });
  });

  it("allows an explicit load path to select the pending installed plugin", async () => {
    const root = dirs.make("claw-configured-plugin-override-");
    const env = sourceHostEnv(root);
    const extensionsDir = path.join(root, "extensions");
    await fs.mkdir(extensionsDir);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}");
    await withEnvAsync(env, async () => {
      await expect(
        preflightClawPackage(pinnedLobster, path.join(root, "workspace"), {
          config: { plugins: { load: { paths: [extensionsDir] } } },
          env,
          deps: {
            preflightPlugin,
            probePlugin,
            inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
          },
        }),
      ).resolves.toMatchObject({ ok: true, action: "install" });
    });
  });

  it("blocks a shadowed plugin upgrade during preview", async () => {
    const root = dirs.make("claw-source-plugin-upgrade-");
    const env = sourceHostEnv(root);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}");
    await withEnvAsync(env, async () => {
      await expect(
        preflightClawPackage(pinnedLobster, path.join(root, "workspace"), {
          config: {},
          env,
          deps: {
            preflightPlugin: async () => ({
              ok: false,
              code: "plugin_version_conflict",
              request: {} as never,
              installedVersion: "2026.6.1",
              expectedVersion: pinnedLobster.version,
            }),
            probePlugin,
            inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
          },
        }),
      ).resolves.toMatchObject({ ok: false, code: "plugin_source_host_conflict" });
    });
  });

  it("rejects a stale plan before writing provenance or invoking the installer", async () => {
    const root = dirs.make("claw-apply-plugin-conflict-");
    const env = sourceHostEnv(root);
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}");
    await withEnvAsync(env, async () => {
      const deps = packageDeps(root, async () => ({}));
      const persistPackageRef = vi.fn(deps.persistPackageRef);
      const installPlugin = vi.fn(async () => {});
      const onExternalMutation = vi.fn();
      await expect(
        installClawPackages(packageInstallPlan([pinnedLobster]), {
          env,
          config: {},
          pluginConsent: {
            onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
          },
          deps: {
            ...deps,
            installPlugin,
            preflightPlugin,
            probePlugin,
            persistPackageRef,
            acquirePackageLease: () => ({ heartbeat: () => true, release: () => {} }),
          },
          onExternalMutation,
        }),
      ).rejects.toMatchObject({ code: "plugin_source_host_conflict", installedPackages: [] });
      expect(persistPackageRef).not.toHaveBeenCalled();
      expect(installPlugin).not.toHaveBeenCalled();
      expect(onExternalMutation).not.toHaveBeenCalled();
    });
  });
});
