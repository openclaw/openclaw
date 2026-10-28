import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { MAX_PLUGIN_RELOAD_TARGETS } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import * as index from "../plugins/installed-plugin-index-records.js";
import type { uninstallPluginWithPolicy } from "../plugins/management-uninstall.js";
import type { PluginManifestSetupProvider } from "../plugins/manifest-types.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { stageClawAddHostRequirementsStateless } from "./add-stateless.js";
import { createStatelessClawPackageReceipt } from "./package-stateless-receipt.js";
import {
  installClawPackages as installClawPackagesCore,
  withPackageBoundaries,
  testPackageLease,
  testPluginProbe,
  testPluginPackage,
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
type InstallOptions = NonNullable<Parameters<typeof installClawPackagesCore>[1]>;
const realPreflightPluginInstall = preflightPluginInstall;
const pluginConsent = {
  onCapabilityConsent: async (review: { reviewToken: string }) => ({
    reviewToken: review.reviewToken,
  }),
};
const quietRuntime = {
  log: () => {},
  error: () => {},
  exit: () => {
    throw new Error("unexpected exit");
  },
};
const pluginPackage = (id: string, version = "1.0.0") => ({
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: `@owner/${id}`,
  version,
  integrity,
});
const demoPlan = () => packageInstallPlan([pluginPackage("demo")]);
const inspectPluginCapabilities = (_rootDir: string, pluginId: string) => ({
  ...emptyPluginCapabilityEvidence,
  grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
});

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
      return testPluginProbe({
        packageName: spec,
        pluginId,
        targetDir: root,
        clawhub: { ...testPluginProbe().clawhub, clawhubPackage: spec },
      });
    },
    inspectPluginCapabilities,
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
async function withRuntime(run: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const { root, env } = await runtimeEnv("claw-runtime-");
  await withEnvAsync(env, () => run(root, env));
}

describe("Claw committed plugin requirement handoff", () => {
  it.each(["unchanged", "reinstalled", "claimed"] as const)(
    "compensates an unpublished %s plugin after runtime batch preparation fails",
    async (ownership) => {
      await withRuntime(async (root, env) => {
        const batch = new PluginInstallRuntimeBatch({ env }, vi.fn());
        const uninstallPlugin = vi.fn(
          async (_params: Parameters<typeof uninstallPluginWithPolicy>[0]) => {},
        );
        let installedAt = "2026-10-14T01:00:00.000Z";
        const deps = {
          ...packageDeps(root),
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          acquirePackageLease: async () => testPackageLease(),
          readPackageRefs: vi.fn().mockResolvedValue([]),
          installPlugin: vi.fn(async () => {}),
          uninstallPlugin,
          resolvePlugin: vi.fn(async () => ({
            status: "found" as const,
            pluginId: "demo",
            installedVersion: "1.0.0",
            record: { source: "clawhub" as const, integrity, installedAt },
          })),
        };
        const plan = demoPlan();
        await withPackageBoundaries(async () => {
          const stage = await stageClawAddHostRequirementsStateless(plan, {
            consentPlanIntegrity: plan.planIntegrity,
            runtimeBatch: batch,
            pluginConsent,
          });
          assert(stage.kind === "ready");
          if (ownership === "reinstalled") {
            installedAt = "2026-10-14T01:00:01.000Z";
          } else if (ownership === "claimed") {
            deps.readPackageRefs.mockResolvedValue([
              createStatelessClawPackageReceipt(plan, pluginPackage("demo"), {
                status: "complete",
                relationship: "referenced",
                origin: "claw-introduced",
                independentOwner: true,
              }),
            ]);
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
          if (ownership === "unchanged") {
            expect(uninstallPlugin).toHaveBeenCalledWith(
              expect.objectContaining({ pluginId: "demo", clawManaged: true }),
            );
            expect(uninstallPlugin.mock.calls[0]?.[0]).not.toHaveProperty("deferRuntime");
          } else {
            expect(uninstallPlugin).not.toHaveBeenCalled();
          }
          expect(result.packages[0]?.status).toBe(
            ownership === "unchanged" ? "rolled_back" : "complete",
          );
        }, deps);
      });
    },
  );

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
    let accessCurrent = true;
    const persistentMutation = vi.fn();
    const installPlugin = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      accessCurrent = false;
      params.beforePersistentApply?.();
      persistentMutation();
    });

    await withRuntime(async (root, env) => {
      await expect(
        installClawPackagesCore(
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

    expect(persistentMutation).not.toHaveBeenCalled();
  });

  it("preserves the install owner's failure instead of a nested CLI exit", async () => {
    installOwner.install.mockReset().mockRejectedValue(installOwner.failure);
    await withRuntime(async (root, env) => {
      const result = await installClawPackagesCore(
        demoPlan(),
        packageOptions(root, env, {
          runtime: quietRuntime,
        }),
      ).catch((error: unknown) => error);
      expect(result).toMatchObject({
        code: "package_install_failed",
        message: installOwner.failure.message,
        cause: installOwner.failure,
        installedPackages: [expect.objectContaining({ ref: "@owner/demo", status: "failed" })],
      });
    });
  });
  it.each([false, true])(
    "applies retained writes once after lease release (late failure=%s)",
    async (lateFailure) => {
      const { root, env } = await runtimeEnv("openclaw-claw-runtime-");
      Object.assign(env, { OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled") });
      const workerEnv = { ...env };
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
          clawHubBaseUrl: "http://127.0.0.1:3323",
          runtime: { ...quietRuntime, log },
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
              expect(params.request).toEqual({
                source: "clawhub",
                packageName: `@owner/${pluginId}`,
                version: "1.0.0",
                mode: "install",
                expectedIntegrity: integrity,
                expectedPluginId: pluginId,
              });
              expect(params.env).toEqual({ ...env, OPENCLAW_CLAWHUB_URL: "http://127.0.0.1:3323" });
              const next: Record<string, PluginInstallRecord> = {
                ...records,
                [pluginId]: {
                  source: "clawhub",
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
        const pending = installClawPackagesCore(plan, options);
        if (lateFailure) {
          await expect(pending).rejects.toMatchObject({
            code: "package_install_failed",
            message: "postcommit metadata failure",
          });
        } else {
          expect(await pending).toMatchObject(
            ["first", "second"].map((id) => ({
              ref: `@owner/${id}`,
              integrity,
              status: "complete",
              relationship: "referenced",
              origin: "claw-introduced",
              independentOwner: false,
            })),
          );
        }
        expect(env).toEqual(workerEnv);
        expect(reloadPlugins).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith("Previous plugin cleanup did not finish.");
        expect(cleanup).toHaveBeenCalledTimes(lateFailure ? 1 : 2);
        expect(log).toHaveBeenCalledWith("Source cleanup warning for first");
      });
    },
  );
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
      clawhub: { ...testPluginProbe().clawhub, clawhubPackage: pinnedBundledPlugin.ref },
    });
  });
  const sourceHostEnv = (prefix: string) =>
    runtimeEnv(prefix, { OPENCLAW_DEV_SOURCE_ROOT: process.cwd() });
  const collisionDeps = {
    preflightPlugin,
    probePlugin,
    inspectPluginCapabilities,
  };
  it.each(["install-preview", "explicit-load-path", "upgrade-preview", "stale-apply"] as const)(
    "enforces source-host selection at %s",
    async (mode) => {
      const { root, env } = await sourceHostEnv("claw-source-plugin-conflict-");
      const extensionsDir = path.join(root, "extensions");
      if (mode === "explicit-load-path") {
        await fs.mkdir(extensionsDir);
      }
      await withEnvAsync(env, async () => {
        const config =
          mode === "explicit-load-path" ? { plugins: { load: { paths: [extensionsDir] } } } : {};
        const deps = {
          ...collisionDeps,
          ...(mode === "upgrade-preview"
            ? {
                preflightPlugin: async () => ({
                  ok: false as const,
                  code: "plugin_version_conflict" as const,
                  installedVersion: "2026.6.1",
                }),
              }
            : {}),
        };
        const sql = mode === "install-preview" ? observeMainThreadSql() : undefined;
        try {
          if (mode === "stale-apply") {
            const installPlugin = vi.fn(async () => {});
            await expect(
              installClawPackagesCore(
                packageInstallPlan([pinnedBundledPlugin]),
                packageOptions(root, env, {
                  config,
                  deps: { ...deps, installPlugin },
                }),
              ),
            ).rejects.toMatchObject({ code: "plugin_source_host_conflict", installedPackages: [] });
            expect(installPlugin).not.toHaveBeenCalled();
          } else {
            await expect(
              preflightClawPackage(pinnedBundledPlugin, path.join(root, "workspace"), {
                config,
                env,
                deps,
              }),
            ).resolves.toMatchObject(
              mode === "explicit-load-path"
                ? { ok: true, action: "install" }
                : {
                    ok: false,
                    code: "plugin_source_host_conflict",
                    message: expect.stringContaining("bundled plugin memory-core"),
                  },
            );
          }
          sql?.expectIdle();
        } finally {
          sql?.restore();
        }
      });
    },
  );
});

describe("Claw package setup and consent", () => {
  const consentPackage = testPluginPackage;
  const pluginProbe = testPluginProbe;
  const plan = packageInstallPlan;
  const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
  const skillPackage = {
    kind: "skill",
    source: "clawhub",
    ref: "@owner/triage",
    version: "1.2.3",
    integrity: skillIntegrity,
  } as const;
  const installedSkill = {
    ok: true as const,
    slug: "triage",
    version: "1.2.3",
    targetDir: "/tmp/incident-2/skills/triage",
  };
  function skillPlan(riskWarning: string) {
    const planned = plan([skillPackage]);
    planned.actions[0]!.details!.riskWarning = riskWarning;
    return planned;
  }
  const consent = { ...pluginConsent, confirmInstall: async () => true };
  async function installClawPackages(
    packagePlan: Parameters<typeof installClawPackagesCore>[0],
    deps: NonNullable<Parameters<typeof installClawPackagesCore>[1]>["deps"],
    options: Omit<NonNullable<Parameters<typeof installClawPackagesCore>[1]>, "deps"> = {},
  ) {
    return await installClawPackagesCore(packagePlan, {
      ...options,
      pluginConsent: consent,
      deps: { inspectPluginCapabilities, acquirePackageLease, ...deps },
    });
  }
  const acquirePackageLease = vi.fn(async () => testPackageLease());
  const preflightSkill = (warning?: string) =>
    vi.fn().mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity, warning });
  const preflightPlugin = (action = "install") => vi.fn().mockResolvedValue({ ok: true, action });
  const reusePlugin = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: integrity,
    });
  const extensionProbe = (mapped = ["skills"]) =>
    vi
      .fn()
      .mockResolvedValue(
        pluginProbe({ artifactInspection: { format: "claude", mapped, unavailable: ["agents"] } }),
      );
  function expectReceipt(
    result: Awaited<ReturnType<typeof installClawPackages>>,
    expected: { integrity: string; relationship: string; origin: string; extension?: unknown },
  ) {
    expect(result).toMatchObject([
      { status: "complete", independentOwner: expected.origin === "pre-existing", ...expected },
    ]);
  }

  describe("preflightClawPackage plugin setup requirements", () => {
    const provider = {
      id: "evidence",
      authMethods: ["api-key"],
      envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
    };
    const preflight = (providers: PluginManifestSetupProvider[], env: NodeJS.ProcessEnv = {}) =>
      preflightClawPackage(consentPackage, "/tmp/workspace", {
        env,
        deps: {
          preflightPlugin: preflightPlugin(),
          probePlugin: withStagedInspection(async () =>
            testPluginProbe({
              pluginId: "evidence",
              setup: { providers },
              artifactInspection: { format: "openclaw", mapped: ["plugin"], unavailable: [] },
            }),
          ),
          inspectPluginCapabilities,
        },
      });
    it.each(["missing", "environment", "oauth-only", "local-file"] as const)(
      "resolves setup requirements with %s credentials",
      async (mode) => {
        let providers: PluginManifestSetupProvider[] = [provider];
        const env: NodeJS.ProcessEnv = {};
        if (mode === "environment") {
          providers = [{ id: "first", envVars: ["FIRST_API_KEY"] }, provider];
          env.EVIDENCE_TOKEN = "configured";
        } else if (mode === "oauth-only") {
          providers = [{ id: "oauth-only", authMethods: ["oauth"] }];
        } else if (mode === "local-file") {
          env.EVIDENCE_CREDENTIALS = path.join(dirs.make("claw-auth-"), "credentials.json");
          env.EVIDENCE_PROJECT = "project";
          await fs.writeFile(env.EVIDENCE_CREDENTIALS, "{}");
          providers = [
            {
              ...provider,
              authEvidence: [
                {
                  type: "local-file-with-env",
                  fileEnvVar: "EVIDENCE_CREDENTIALS",
                  requiresAllEnv: ["EVIDENCE_PROJECT"],
                  credentialMarker: "evidence-local-credentials",
                },
              ],
            },
          ];
        }
        const result = await preflight(providers, env);
        if (mode === "missing") {
          expect(result.requirements).toEqual([
            {
              kind: "plugin-setup",
              plugin: "evidence",
              provider: provider.id,
              envVars: provider.envVars,
              authMethods: provider.authMethods,
            },
          ]);
        } else {
          expect(result).not.toHaveProperty("requirements");
        }
      },
    );
  });

  describe("installClawPackages", () => {
    const extension = {
      id: "audit-tools",
      format: "claude" as const,
      detectedFormat: "claude" as const,
      mapped: ["skills"],
      unavailable: ["agents"],
      adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
    };

    it("rejects an unreviewed skill warning before recording a ref or installing bytes", async () => {
      const planned = skillPlan("Review this skill.");
      const installSkill = vi.fn();

      await expect(
        installClawPackages(planned, {
          preflightSkill: preflightSkill("Review this skill."),
          installSkill,
        }),
      ).rejects.toMatchObject({ code: "skill_consent_required" });
      expect(installSkill).not.toHaveBeenCalled();
    });

    it("accepts only the reviewed skill warning at the installer trust check", async () => {
      const planned = skillPlan("Review this skill.");
      const skillConsent = { assertApproved: vi.fn() };
      const installSkill = vi.fn(
        async (params: {
          beforePersistentApply?: () => void;
          confirmInstall?: (warning?: string) => boolean | Promise<boolean>;
        }) => {
          params.beforePersistentApply?.();
          expect(await params.confirmInstall?.("Review this skill.")).toBe(true);
          expect(await params.confirmInstall?.("Changed trust warning.")).toBe(false);
          return installedSkill;
        },
      );

      const result = await installClawPackages(
        planned,
        {
          preflightSkill: preflightSkill("Review this skill."),
          installSkill,
        },
        { skillConsent },
      );
      expect(installSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceDir: "/tmp/incident-2",
          slug: "@owner/triage",
          version: "1.2.3",
          expectedIntegrity: skillIntegrity,
          clawManaged: true,
          beforePersistentApply: expect.any(Function),
        }),
      );
      expectReceipt(result, {
        integrity: skillIntegrity,
        relationship: "managed",
        origin: "claw-introduced",
      });
      expect(skillConsent.assertApproved).toHaveBeenCalledWith({
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
        riskWarning: "Review this skill.",
      });
    });

    it("records a dependency ref without reinstalling an exact reused plugin", async () => {
      const installPlugin = vi.fn();

      const result = await installClawPackages(plan([{ ...consentPackage, extension }], "reuse"), {
        installPlugin,
        probePlugin: withStagedInspection(extensionProbe()),
        preflightPlugin: reusePlugin(),
      });

      expect(installPlugin).not.toHaveBeenCalled();
      expectReceipt(result, {
        integrity,
        extension,
        relationship: "referenced",
        origin: "pre-existing",
      });
    });

    it("rejects changed extension inspection before recording reused plugin provenance", async () => {
      await expect(
        installClawPackages(plan([{ ...consentPackage, extension }], "reuse"), {
          installPlugin: vi.fn(),
          probePlugin: withStagedInspection(extensionProbe(["skills", "commands"])),
          preflightPlugin: reusePlugin(),
        }),
      ).rejects.toMatchObject({
        code: "package_owner_state_changed",
        message: expect.stringContaining("identity or trust state changed after planning"),
      });
    });

    it("invalidates consent when plugin owner state changes after planning", async () => {
      const installPlugin = vi.fn();

      await expect(
        installClawPackages(plan([consentPackage]), {
          installPlugin,
          preflightPlugin: preflightPlugin("reuse"),
        }),
      ).rejects.toMatchObject({ code: "package_owner_state_changed" });
      expect(installPlugin).not.toHaveBeenCalled();
    });

    it.each(["skill", "plugin"] as const)("invalidates changed %s trust warnings", async (kind) => {
      const planned = plan([kind === "skill" ? skillPackage : consentPackage]);
      Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });
      const deps =
        kind === "skill"
          ? { preflightSkill: preflightSkill("review warning two") }
          : {
              probePlugin: withStagedInspection(
                vi.fn().mockResolvedValue({
                  ok: true,
                  pluginId: "audit",
                  warning: "review warning two",
                  clawhub: { integrity },
                }),
              ),
            };
      await expect(installClawPackages(planned, deps)).rejects.toMatchObject({
        code: "package_owner_state_changed",
      });
    });
  });
});
