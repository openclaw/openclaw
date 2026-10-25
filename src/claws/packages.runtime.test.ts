import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PLUGIN_RELOAD_TARGETS } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import * as index from "../plugins/installed-plugin-index-records.js";
import type { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { stageClawAddHostRequirementsStateless } from "./add-stateless.js";
import {
  installClawPackages,
  rollbackStatelessClawPackages,
  withPackageBoundaries,
  testPackageLease,
  testPluginProbe,
  withStagedInspection,
} from "./packages.boundary.test-support.js";
import { preflightClawPackage } from "./packages.js";
import { emptyPluginCapabilityEvidence, packageInstallPlan } from "./packages.test-support.js";
import { runClawPluginBatch } from "./plugin-runtime.js";

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
const realPreflightPluginInstall = preflightPluginInstall;
const pluginConsent = {
  onCapabilityConsent: async (review: { reviewToken: string }) => ({
    reviewToken: review.reviewToken,
  }),
};
const pluginPackage = (id: string, version = "1.0.0") => ({
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: `@owner/${id}`,
  version,
  integrity,
});
const demoPlan = () => packageInstallPlan([pluginPackage("demo")]);

async function runtimeEnv(prefix: string, extra: NodeJS.ProcessEnv = {}) {
  const root = dirs.make(prefix);
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    ...extra,
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
  return { root, env };
}

function packageDeps(
  root: string,
  load: () => Promise<Record<string, PluginInstallRecord>> = async () => ({}),
) {
  return {
    preflightPlugin: async (params) => {
      using _ = vi.spyOn(index, "loadInstalledPluginIndexInstallRecords").mockImplementation(load);
      return await realPreflightPluginInstall(params);
    },
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
    inspectPluginCapabilities: (_rootDir, pluginId) => ({
      ...emptyPluginCapabilityEvidence,
      grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
    }),
  } satisfies InstallOptions["deps"];
}

function packageOptions(
  root: string,
  env: NodeJS.ProcessEnv,
  { deps, ...options }: InstallOptions = {},
): InstallOptions {
  return {
    env,
    pluginConsent,
    ...options,
    deps: { ...packageDeps(root), acquirePackageLease: async () => testPackageLease(), ...deps },
  };
}

describe("Claw committed plugin requirement handoff", () => {
  it("rolls back an unpublished plugin after runtime batch preparation fails", async () => {
    const { root, env } = await runtimeEnv("openclaw-claw-batch-rollback-");
    await withEnvAsync(env, async () => {
      const batch = new PluginInstallRuntimeBatch({ env }, vi.fn());
      const uninstallPlugin = vi.fn(
        async (_params: Parameters<typeof uninstallPluginWithPolicy>[0]) => {},
      );
      const deps: NonNullable<InstallOptions["deps"]> = {
        ...packageDeps(root),
        preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
        acquirePackageLease: async () => testPackageLease(),
        readPackageRefs: vi.fn().mockResolvedValue([]),
        installPlugin: vi.fn(async () => {}),
        uninstallPlugin,
        resolvePlugin: vi.fn().mockResolvedValue({
          status: "found",
          pluginId: "demo",
          installedVersion: "1.0.0",
          record: { source: "clawhub", integrity, installedAt: "2026-10-14T01:00:00.000Z" },
        }),
      };
      const plan = demoPlan();
      await withPackageBoundaries(async () => {
        const stage = await stageClawAddHostRequirementsStateless(plan, {
          consentPlanIntegrity: plan.planIntegrity,
          runtimeBatch: batch,
          pluginConsent,
        });
        expect(stage.kind).toBe("ready");
        if (stage.kind !== "ready") {
          return;
        }

        batch.retain("missing-plugin");
        await withPluginLifecycleLease({ env }, async (lease) => {
          await expect(batch.prepare(lease)).rejects.toThrow("no longer installed");
        });
        batch.close();
        const result = await stage.failBeforeContinue(
          new Error("batch preparation failed"),
          "package_runtime_failed",
        );

        expect(result.error).toMatchObject({ code: "package_runtime_failed" });
        expect(uninstallPlugin).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "demo" }));
        expect(uninstallPlugin.mock.calls[0]?.[0]).not.toHaveProperty("deferRuntime");
        expect(result.packages[0]?.status).toBe("rolled_back");
      }, deps);
    });
  });

  it("rejects an oversized external runtime batch before starting package work", async () => {
    const run = vi.fn(async () => "mutated");
    const batch = new PluginInstallRuntimeBatch({}, vi.fn());

    await expect(
      runClawPluginBatch(
        { runtimeBatch: batch },
        MAX_PLUGIN_RELOAD_TARGETS + 1,
        run,
        () => new Error("unexpected runtime failure"),
      ),
    ).rejects.toThrow(`at most ${MAX_PLUGIN_RELOAD_TARGETS} plugin packages`);
    expect(run).not.toHaveBeenCalled();
    batch.close();
  });

  it("rechecks reviewed access at a managed plugin's persistent install boundary", async () => {
    const { root, env } = await runtimeEnv("openclaw-claw-access-guard-");
    let accessCurrent = true;
    const persistentMutation = vi.fn();
    const installPlugin = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      accessCurrent = false;
      params.beforePersistentApply?.();
      persistentMutation();
    });

    await withEnvAsync(env, async () => {
      await expect(
        installClawPackages(
          demoPlan(),
          packageOptions(root, env, {
            assertForwardCurrent: () => {
              if (!accessCurrent) {
                throw new Error("reviewed access changed");
              }
            },
            pluginConsent: { ...pluginConsent, confirmInstall: async () => true },
            deps: {
              preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
              installPlugin,
            },
          }),
        ),
      ).rejects.toThrow("reviewed access changed");
    });

    expect(installPlugin).toHaveBeenCalledOnce();
    expect(persistentMutation).not.toHaveBeenCalled();
  });

  it("preserves the install owner's failure instead of a nested CLI exit", async () => {
    const { root, env } = await runtimeEnv("openclaw-claw-install-error-");
    installOwner.install.mockReset().mockRejectedValue(installOwner.failure);
    await withEnvAsync(env, async () => {
      const result = await installClawPackages(
        demoPlan(),
        packageOptions(root, env, {
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected outer exit");
            },
          },
        }),
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
      const { root, env } = await runtimeEnv("openclaw-claw-runtime-");
      Object.assign(env, { OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled") });
      await withEnvAsync(env, async () => {
        let records: Record<string, PluginInstallRecord> = {};
        let heldPackages = 0;
        const cleanup = vi.fn();
        const log = vi.fn();
        const assertForwardCurrent = vi.fn();
        const reloadPlugins = vi.fn<PluginInstallBatchReload>(async (targets, reloadOptions) => {
          expect(reloadOptions?.commitGuard).toBe(assertForwardCurrent);
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
          pluginConsent,
          runtime: {
            log,
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          reloadPlugins,
          assertForwardCurrent,
          deps: {
            ...packageDeps(root, async () => records),
            acquirePackageLease: async () => {
              heldPackages++;
              return testPackageLease(() => {
                heldPackages--;
              });
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
        const plan = packageInstallPlan(["first", "second"].map((id) => pluginPackage(id)));
        const pending = installClawPackages(plan, options);
        if (lateFailure) {
          await expect(pending).rejects.toMatchObject({
            code: "package_install_failed",
            message: "postcommit metadata failure",
          });
        } else {
          expect(await pending).toHaveLength(2);
        }
        expect(reloadPlugins).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith("Previous plugin cleanup did not finish.");
        expect(cleanup).toHaveBeenCalledTimes(lateFailure ? 1 : 2);
        expect(log).toHaveBeenCalledWith("Source cleanup warning for first");
      });
    },
  );
});

describe("stateless Claw plugin rollback", () => {
  const auditPackage = pluginPackage("audit", "2.0.1");

  function rollbackDeps(installedAt: () => string) {
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    return {
      uninstallPlugin,
      installPlugin: vi.fn().mockResolvedValue(undefined),
      preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
      probePlugin: vi.fn(withStagedInspection(async () => testPluginProbe())),
      inspectPluginCapabilities: vi.fn((_rootDir: string, pluginId: string) => ({
        ...emptyPluginCapabilityEvidence,
        grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
      })),
      resolvePlugin: vi.fn(async () => ({
        status: "found" as const,
        pluginId: "audit",
        installedVersion: auditPackage.version,
        record: { source: "clawhub" as const, integrity, installedAt: installedAt() },
      })),
      readPackageRefs: vi.fn().mockResolvedValue([]),
      acquirePackageLease: vi.fn(async () => testPackageLease()),
    };
  }

  const rollbackConsent = { ...pluginConsent, confirmInstall: async () => true };
  const install = (deps: ReturnType<typeof rollbackDeps>) =>
    installClawPackages(packageInstallPlan([auditPackage]), {
      pluginConsent: rollbackConsent,
      deps,
    });

  it("removes an unchanged plugin introduced by an unpublished Add", async () => {
    const deps = rollbackDeps(() => "2026-10-14T01:00:00.000Z");
    const refs = await install(deps);

    expect(await rollbackStatelessClawPackages(refs, { deps })).toEqual([]);
    expect(deps.uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "audit", clawManaged: true }),
    );
    expect(refs[0]?.status).toBe("rolled_back");
  });

  it("keeps an introduced plugin if its install identity changed", async () => {
    let installedAt = "2026-10-14T01:00:00.000Z";
    const deps = rollbackDeps(() => installedAt);
    const refs = await install(deps);
    installedAt = "2026-10-14T01:00:01.000Z";

    expect(await rollbackStatelessClawPackages(refs, { deps })).toEqual([]);
    expect(deps.uninstallPlugin).not.toHaveBeenCalled();
    expect(refs[0]?.status).toBe("complete");
  });

  it("keeps an introduced plugin if a legacy owner claims it before rollback", async () => {
    const deps = rollbackDeps(() => "2026-10-14T01:00:00.000Z");
    const refs = await install(deps);
    deps.readPackageRefs.mockResolvedValue(refs.map((ref) => ({ ...ref, independentOwner: true })));

    expect(await rollbackStatelessClawPackages(refs, { deps })).toEqual([]);
    expect(deps.uninstallPlugin).not.toHaveBeenCalled();
    expect(refs[0]?.status).toBe("complete");
  });
});

describe("Claw source-host plugin collision", () => {
  const pinnedBundledPlugin = {
    kind: "plugin",
    source: "clawhub",
    ref: "@openclaw/memory-core",
    version: "2026.7.1",
    integrity,
  } as const;
  const preflightPlugin = vi.fn(async () => ({
    ok: true as const,
    action: "install" as const,
  }));
  const probePlugin = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
    await request.onPluginArtifactInspect?.({
      pluginId: "memory-core",
      stagedArtifactDir: path.join(process.cwd(), "extensions", "memory-core"),
      mode: "install",
    });
    return testPluginProbe({
      pluginId: "memory-core",
      packageName: pinnedBundledPlugin.ref,
      targetDir: "/tmp/memory-core",
      artifactInspection: { format: "openclaw" as const, mapped: ["plugin"], unavailable: [] },
      clawhub: {
        source: "clawhub" as const,
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: pinnedBundledPlugin.ref,
        clawhubFamily: "code-plugin" as const,
        integrity,
      },
    });
  });
  const sourceHostEnv = (prefix: string) =>
    runtimeEnv(prefix, { OPENCLAW_DEV_SOURCE_ROOT: process.cwd() });
  const collisionDeps = {
    preflightPlugin,
    probePlugin,
    inspectPluginCapabilities: (_rootDir: string, pluginId: string) => ({
      ...emptyPluginCapabilityEvidence,
      grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
    }),
  };
  function preflight(
    root: string,
    env: NodeJS.ProcessEnv,
    options: Parameters<typeof preflightClawPackage>[2] = {},
  ) {
    return preflightClawPackage(pinnedBundledPlugin, path.join(root, "workspace"), {
      config: {},
      env,
      ...options,
      deps: { ...collisionDeps, ...options.deps },
    });
  }

  it("blocks the pinned ClawHub plugin before installation", async () => {
    const { root, env } = await sourceHostEnv("claw-source-plugin-conflict-");
    await withEnvAsync(env, async () => {
      const sql = observeMainThreadSql();
      try {
        await expect(preflight(root, env)).resolves.toMatchObject({
          ok: false,
          code: "plugin_source_host_conflict",
          message: expect.stringContaining("bundled plugin memory-core"),
        });
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    });
  });

  it("allows an explicit load path to select the pending installed plugin", async () => {
    const { root, env } = await sourceHostEnv("claw-configured-plugin-override-");
    const extensionsDir = path.join(root, "extensions");
    await fs.mkdir(extensionsDir);
    await withEnvAsync(env, async () => {
      await expect(
        preflight(root, env, {
          config: { plugins: { load: { paths: [extensionsDir] } } },
        }),
      ).resolves.toMatchObject({ ok: true, action: "install" });
    });
  });

  it("blocks a shadowed plugin upgrade during preview", async () => {
    const { root, env } = await sourceHostEnv("claw-source-plugin-upgrade-");
    await withEnvAsync(env, async () => {
      await expect(
        preflight(root, env, {
          deps: {
            preflightPlugin: async () => ({
              ok: false,
              code: "plugin_version_conflict",
              installedVersion: "2026.6.1",
            }),
          },
        }),
      ).resolves.toMatchObject({ ok: false, code: "plugin_source_host_conflict" });
    });
  });

  it("rejects a stale plan before writing provenance or invoking the installer", async () => {
    const { root, env } = await sourceHostEnv("claw-apply-plugin-conflict-");
    await withEnvAsync(env, async () => {
      const installPlugin = vi.fn(async () => {});
      await expect(
        installClawPackages(
          packageInstallPlan([pinnedBundledPlugin]),
          packageOptions(root, env, {
            config: {},
            deps: {
              installPlugin,
              preflightPlugin,
              probePlugin,
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "plugin_source_host_conflict", installedPackages: [] });
      expect(installPlugin).not.toHaveBeenCalled();
    });
  });
});
