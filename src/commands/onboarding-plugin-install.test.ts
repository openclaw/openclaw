// Onboarding plugin install tests cover install sources, trust checks, and install records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord as PersistedPluginInstallRecord } from "../config/types.plugins.js";
import type { PluginEnableResult } from "../plugins/enable.js";
import { installPluginDirectoryIntoExtensions } from "../plugins/install-shared.js";
import type { PluginInstallArtifactConsentHandler } from "../plugins/install-types.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { VERSION } from "../version.js";
import { WizardNavigationError } from "../wizard/prompts.js";
import { WizardSession } from "../wizard/session.js";

// Stable setup is the default fixture, independent of the checkout's release version.
const coreVersion = vi.hoisted(() => ({ value: "2026.8.1" }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return coreVersion.value;
  },
}));

const resolveBundledInstallPlanForCatalogEntry = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => unknown>(() => undefined),
);
vi.mock("../plugins/install-source-plan.js", () => ({
  resolveBundledInstallPlanForCatalogEntry,
}));

const invalidatePluginRuntimeDiscoveryAfterConfigMutation = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
vi.mock("../plugins/registry-refresh.js", () => ({
  invalidatePluginRuntimeDiscoveryAfterConfigMutation,
}));

const resolveBundledPluginSources = vi.hoisted(() => vi.fn(() => new Map()));
const findBundledPluginSourceInMap = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { localPath: string } | undefined>(() => undefined),
);
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources,
  findBundledPluginSourceInMap,
}));

const installPluginFromNpmSpec = vi.hoisted(() => vi.fn());
const installPluginFromNpmPackArchive = vi.hoisted(() => vi.fn());
const runCommandWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout,
}));
vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec,
  installPluginFromNpmPackArchive,
}));

const installPluginFromClawHub = vi.hoisted(() => vi.fn());
vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
  },
  installPluginFromClawHub,
}));

const enablePluginInConfig = vi.hoisted(() =>
  vi.fn<(cfg: OpenClawConfig, pluginId: string) => PluginEnableResult>((cfg, pluginId) => ({
    config: cfg,
    enabled: true,
    pluginId,
  })),
);
vi.mock("../plugins/enable.js", () => ({
  enableExplicitlySelectedPluginInConfig: enablePluginInConfig,
  enablePluginInConfig,
}));

const recordPluginInstall = vi.hoisted(() =>
  vi.fn((cfg: OpenClawConfig, update: { pluginId: string }) => ({
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...cfg.plugins?.installs,
        [update.pluginId]: update,
      },
    },
  })),
);
const buildNpmResolutionInstallFields = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("../plugins/installs.js", () => ({
  recordPluginInstall,
  buildNpmResolutionInstallFields,
}));

const clearPluginMetadataLifecycleCaches = vi.hoisted(() => vi.fn());
vi.mock("../plugins/plugin-metadata-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-lifecycle.js")>()),
  clearPluginMetadataLifecycleCaches,
}));
const clearLoadInstalledPluginIndexInstallRecordsCache = vi.hoisted(() => vi.fn());
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>()),
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

const withPluginLifecycleLease = vi.hoisted(() =>
  vi.fn(async (_options: unknown, run: () => Promise<unknown>) => await run()),
);
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease,
}));

const withTimeout = vi.hoisted(() => vi.fn(async <T>(promise: Promise<T>) => await promise));
vi.mock("../utils/with-timeout.js", () => ({
  withTimeout,
}));

const prepareManagedPluginArtifactConsentHandler = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/capability-consent.js").prepareManagedPluginArtifactConsentHandler
  >(),
);
vi.mock("../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler,
}));

import { ensureChannelSetupPluginInstalled } from "./channel-setup/plugin-install.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
} from "./onboarding-plugin-install.js";

function installEntry(
  install: OnboardingPluginInstallEntry["install"],
  details: Partial<Omit<OnboardingPluginInstallEntry, "install">> = {},
): OnboardingPluginInstallEntry {
  return { pluginId: "demo-plugin", label: "Demo Plugin", install, ...details };
}

function installPolicyConfig(): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: { source: "exec", command: process.execPath, args: ["-e", "process.exit(1)"] },
      },
    },
  };
}

function clawHubRecord() {
  return {
    source: "clawhub",
    clawhubUrl: "https://clawhub.ai",
    clawhubPackage: "demo-plugin",
    clawhubFamily: "code-plugin",
    clawhubChannel: "official",
    version: "2026.5.2",
    integrity: "sha256-clawpack",
    resolvedAt: "2026-05-02T00:00:00.000Z",
    clawpackSha256: "a".repeat(64),
    clawpackSpecVersion: 1,
    clawpackManifestSha256: "b".repeat(64),
    clawpackSize: 4096,
  };
}

function requireCapturedPrompt<T>(captured: T | undefined): T {
  if (!captured) {
    throw new Error("expected captured install prompt");
  }
  return captured;
}

type InstallChoice = "clawhub" | "npm" | "local" | "skip";
type InstallPrompt = {
  message: string;
  options: Array<{ value: InstallChoice; label: string; hint?: string }>;
  initialValue: InstallChoice;
};

type MockWithUnknownCalls = {
  mock: {
    calls: unknown[][];
  };
};

function readFirstMockCall(mock: unknown, label: string): unknown[] {
  const calls = (mock as MockWithUnknownCalls).mock.calls;
  const call = calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

type NpmPackInstallCall = {
  archivePath?: string;
  config?: OpenClawConfig;
  expectedPluginId?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type NpmSpecInstallCall = {
  config?: OpenClawConfig;
  expectedIntegrity?: string;
  expectedPluginId?: string;
  mode?: string;
  spec?: string;
  timeoutMs?: number;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type ClawHubInstallCall = {
  config?: OpenClawConfig;
  expectedPluginId?: string;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  mode?: string;
  spec?: string;
  timeoutMs?: number;
};

type PluginInstallRecord = Partial<PersistedPluginInstallRecord> & { pluginId?: string };

function mockNpmChannelMetadata(
  name: string,
  beta: string | undefined,
  latest: string | undefined,
) {
  for (const version of [beta, latest]) {
    runCommandWithTimeout.mockResolvedValueOnce(
      version
        ? { code: 0, stdout: JSON.stringify({ name, version }), stderr: "" }
        : { code: 1, stdout: "", stderr: "npm error code E404" },
    );
  }
}

describe("ensureOnboardingPluginInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandWithTimeout.mockReset();
    vi.stubEnv("OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES", undefined);
    vi.stubEnv("OPENCLAW_PLUGIN_INSTALL_OVERRIDES", undefined);
    withTimeout.mockImplementation(async <T>(promise: Promise<T>) => await promise);
    prepareManagedPluginArtifactConsentHandler.mockResolvedValue({
      onBeforePluginArtifactCommit: async () => {},
      applyAcceptedSurface: (_pluginId, record) => record,
    });
    invalidatePluginRuntimeDiscoveryAfterConfigMutation.mockResolvedValue(undefined);
  });

  afterEach(() => {
    coreVersion.value = "2026.8.1";
    vi.unstubAllEnvs();
  });

  it.each(["npm", "clawhub"] as const)(
    "reports only installer activity while %s is pending",
    async (source) => {
      vi.useFakeTimers();
      const started = createDeferredCore();
      const release = createDeferredCore();
      const update = vi.fn();
      const stop = vi.fn();
      const install = async (params: ClawHubInstallCall) => {
        params.logger?.info?.("Downloading demo-plugin\u001b[31m from registry…");
        started.resolve();
        await release.promise;
        return { ok: false, error: "registry unavailable" };
      };
      if (source === "clawhub") {
        installPluginFromClawHub.mockImplementationOnce(install);
      } else {
        installPluginFromNpmSpec.mockImplementationOnce(install);
      }
      const pending = ensureOnboardingPluginInstalled({
        cfg: {},
        entry: {
          pluginId: "demo-plugin",
          label: "Demo Plugin",
          install:
            source === "clawhub"
              ? { clawhubSpec: "clawhub:demo-plugin@1.0.0" }
              : { npmSpec: "@demo/plugin@1.0.0" },
          preferRemoteInstall: true,
        },
        prompter: {
          progress: () => ({ update, stop }),
          note: vi.fn(async () => {}),
        } as never,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        promptInstall: false,
      });
      try {
        await started.promise;
        const updates = [...update.mock.calls];
        await vi.advanceTimersByTimeAsync(12_000);
        expect(update.mock.calls).toEqual(updates);
        expect(update).toHaveBeenLastCalledWith("Downloading demo-plugin from registry…");
        expect(stop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        vi.useRealTimers();
      }
      expect(stop).toHaveBeenCalledWith("Install failed: Demo Plugin");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(recordPluginInstall).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...(["npm", "clawhub", "npm-pack", "local"] as const).flatMap((source) =>
      [false, true].map((accepted) => ({
        source,
        accepted,
        official: false,
        promptError: undefined,
      })),
    ),
    ...(["npm", "clawhub"] as const).map((source) => ({
      source,
      accepted: false,
      official: true,
      promptError: undefined,
    })),
    {
      source: "local" as const,
      accepted: false,
      official: false,
      promptError: new WizardNavigationError("back"),
    },
    ...(["npm", "clawhub"] as const).map((source) => ({
      source,
      accepted: false,
      official: false,
      promptError: new Error("capability review guard rejected the operation"),
    })),
  ])(
    "reviews $source artifact capabilities before onboarding activation, official=$official accepted=$accepted promptError=$promptError",
    async ({ source, accepted, promptError, official }) => {
      const consentRequired = !official;
      const shouldInstall = !consentRequired || accepted;
      const actual = await vi.importActual<typeof import("../plugins/capability-consent.js")>(
        "../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementationOnce(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      await withTestDir({ prefix: "openclaw-onboarding-consent-" }, async (artifactDir) => {
        const pluginId = official ? "diffs" : "demo-plugin";
        const packageName = official ? "@openclaw/diffs" : "demo-plugin";
        const npmSpec = official ? "@openclaw/diffs@1.0.0" : "@example/demo-plugin@1.0.0";
        const clawhubSpec = `clawhub:${packageName}@1.0.0`;
        const sourceRecord: PersistedPluginInstallRecord | undefined = !official
          ? undefined
          : source === "npm"
            ? { source: "npm", spec: npmSpec, resolvedName: packageName, resolvedSpec: npmSpec }
            : {
                source: "clawhub",
                spec: clawhubSpec,
                clawhubPackage: packageName,
                clawhubUrl: "https://clawhub.ai",
                clawhubChannel: "official",
              };
        createColdPluginFixture({
          rootDir: artifactDir,
          pluginId,
          ...(official ? { packageName } : {}),
          manifest: { contracts: { tools: ["demo.write"] } },
        });
        let committed = false;
        const install = async (params: {
          onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
        }) => {
          await params.onBeforePluginArtifactCommit?.({
            pluginId,
            stagedArtifactDir: artifactDir,
            mode: "install",
            ...(sourceRecord ? { sourceRecord } : {}),
          });
          committed = true;
          return {
            ok: true,
            pluginId,
            targetDir: artifactDir,
            version: "1.0.0",
            ...(source === "clawhub"
              ? { clawhub: { source: "clawhub", clawhubPackage: packageName } }
              : {}),
          };
        };
        if (source === "npm-pack") {
          process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
          process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
            "demo-plugin": `npm-pack:${path.join(artifactDir, "plugin.tgz")}`,
          });
          installPluginFromNpmPackArchive.mockImplementationOnce(install);
        } else if (source === "clawhub") {
          installPluginFromClawHub.mockImplementationOnce(install);
        } else if (source === "npm") {
          installPluginFromNpmSpec.mockImplementationOnce(install);
        }
        const beforePersistentEffect = vi.fn();
        const confirm = vi.fn(async () => {
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          if (promptError) {
            throw promptError;
          }
          return accepted;
        });
        const note = vi.fn(async () => {});
        const log = vi.fn();
        if (shouldInstall || source === "local") {
          const actualEnable =
            await vi.importActual<typeof import("../plugins/enable.js")>("../plugins/enable.js");
          enablePluginInConfig.mockImplementationOnce(
            actualEnable.enableExplicitlySelectedPluginInConfig,
          );
        }
        const cfg: OpenClawConfig = { plugins: { entries: { [pluginId]: { enabled: false } } } };
        const pending = ensureOnboardingPluginInstalled({
          cfg,
          entry: {
            pluginId,
            label: "Demo Plugin",
            install:
              source === "local"
                ? { localPath: artifactDir }
                : source === "clawhub"
                  ? { clawhubSpec }
                  : { npmSpec },
            preferRemoteInstall: source !== "local",
          },
          prompter: {
            confirm,
            note,
            progress: () => ({ update: vi.fn(), stop: vi.fn() }),
          } as never,
          runtime: { log, error: vi.fn() } as never,
          promptInstall: false,
          workspaceDir: artifactDir,
          beforePersistentEffect,
        });
        if (promptError) {
          await expect(pending).rejects.toBe(promptError);
          expect(committed).toBe(false);
          expect(recordPluginInstall).not.toHaveBeenCalled();
          return;
        }
        const result = await pending;

        expect(confirm).toHaveBeenCalledTimes(consentRequired ? 1 : 0);
        if (consentRequired) {
          expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
          expect([...note.mock.calls, ...log.mock.calls].flat().join("\n")).toContain("demo.write");
        }
        if (source !== "local") {
          expect(committed).toBe(shouldInstall);
        }
        if (shouldInstall) {
          expect(beforePersistentEffect).toHaveBeenCalledOnce();
          expect(result).toMatchObject({ installed: true, status: "installed" });
          expect(result.cfg.plugins?.entries?.[pluginId]?.enabled).toBe(true);
          const recorded = result.cfg.plugins?.installs?.[pluginId];
          if (consentRequired) {
            expect(recorded).toMatchObject({
              acceptedSurface: { tools: ["demo.write"] },
              acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
              acceptedSurfaceAt: expect.any(String),
            });
          } else {
            expect(recorded?.acceptedSurface).toBeUndefined();
            expect(recorded?.acceptedSurfaceAt).toBeUndefined();
          }
        } else {
          expect(beforePersistentEffect).not.toHaveBeenCalled();
          expect(result).toMatchObject({ installed: false, status: "failed", cfg });
          expect(recordPluginInstall).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    { entryPoint: "onboarding", action: "cancel" },
    { entryPoint: "onboarding", action: "expire" },
    { entryPoint: "channel", action: "commit" },
  ] as const)(
    "keeps hosted $entryPoint artifact review cancellable until commit ($action)",
    async ({ entryPoint, action }) => {
      const actual = await vi.importActual<typeof import("../plugins/capability-consent.js")>(
        "../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementationOnce(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      await withTestDir({ prefix: "openclaw-hosted-install-consent-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "installed", "demo-plugin");
        await fs.mkdir(sourceDir);
        createColdPluginFixture({ rootDir: sourceDir, pluginId: "demo-plugin" });
        const committed = createDeferredCore();
        const releaseInstaller = createDeferredCore();
        installPluginFromNpmSpec.mockImplementationOnce(
          async (params: {
            onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
          }) => {
            const result = await installPluginDirectoryIntoExtensions({
              sourceDir,
              targetDir,
              pluginId: "demo-plugin",
              extensions: ["index.cjs"],
              logger: {},
              timeoutMs: 10_000,
              mode: "install",
              dryRun: false,
              copyErrorPrefix: "failed to stage fixture",
              hasDeps: false,
              depsLogMessage: "fixture has no dependencies",
              onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
            });
            committed.resolve();
            await releaseInstaller.promise;
            return result;
          },
        );
        if (action === "expire") {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        }
        const session = new WizardSession(
          async (prompter, _signal, owner) => {
            const shared = {
              cfg: {},
              prompter,
              runtime: { log: vi.fn(), error: vi.fn() } as never,
              promptInstall: false,
              beforePersistentEffect: async () => {
                owner.lockCancellation();
              },
            };
            const install = { npmSpec: "@example/demo-plugin@1.0.0" };
            if (entryPoint === "channel") {
              await ensureChannelSetupPluginInstalled({
                ...shared,
                entry: {
                  id: "demo-channel",
                  pluginId: "demo-plugin",
                  meta: {
                    id: "demo-channel",
                    label: "Demo channel",
                    selectionLabel: "Demo channel",
                    docsPath: "/channels/demo",
                    blurb: "Fixture channel",
                  },
                  install,
                },
              });
            } else {
              await ensureOnboardingPluginInstalled({
                ...shared,
                entry: {
                  pluginId: "demo-plugin",
                  label: "Demo plugin",
                  install,
                  preferRemoteInstall: true,
                },
              });
            }
          },
          action === "expire" ? { timeoutMs: 1_000 } : undefined,
        );
        try {
          let pending = await session.next();
          while (pending.step && pending.step.type !== "confirm") {
            if (pending.step.type !== "progress") {
              await session.answer(pending.step.id, undefined);
            }
            pending = await session.next();
          }
          expect(pending.step?.type).toBe("confirm");
          const step = requireCapturedPrompt(pending.step);
          if (action === "commit") {
            await session.answer(step.id, true);
            await committed.promise;
            expect(await fs.stat(targetDir)).toBeDefined();
            expect(session.cancel()).toBe(false);
          } else {
            if (action === "expire") {
              await vi.advanceTimersByTimeAsync(1_000);
            } else {
              session.cancel();
            }
            const status = session.getStatus();
            // Unwind the broken pre-fix path before asserting, so its locked
            // prompt cannot leak a runner into the next case.
            if (status === "running") {
              await session.answer(step.id, false);
            }
            await session.whenSettled();
            expect(status).toBe("cancelled");
            await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
            expect(recordPluginInstall).not.toHaveBeenCalled();
          }
        } finally {
          releaseInstaller.resolve();
          await session.whenSettled();
          vi.useRealTimers();
        }
      });
    },
  );

  it("localizes plugin install choices", async () => {
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    let captured: InstallPrompt | undefined;

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry(
        {
          npmSpec: "@tencent-connect/openclaw-qqbot@2.0.1",
        },
        { pluginId: "openclaw-qqbot", label: "QQ Bot" },
      ),
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.message).toBe("安装 QQ Bot 插件？");
    expect(captured?.options).toEqual([
      { value: "npm", label: "从 npm 下载（@tencent-connect/openclaw-qqbot@2.0.1）" },
      { value: "skip", label: "暂时跳过" },
    ]);
  });

  it("localizes plugin install progress and enablement failures", async () => {
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    enablePluginInConfig.mockReturnValueOnce({
      config: {},
      enabled: false,
      pluginId: "demo-plugin",
      reason: "blocked by allowlist",
    });
    installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/demo-plugin",
      version: "1.2.3",
    });
    const note = vi.fn(async () => {});
    const progress = vi.fn(() => ({ update: vi.fn(), stop: vi.fn() }));

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry({
        npmSpec: "@demo/plugin@1.2.3",
      }),
      prompter: {
        select: vi.fn(async () => "npm"),
        note,
        progress,
      } as never,
      runtime: { error: vi.fn() } as never,
    });

    expect(progress).toHaveBeenCalledWith("正在安装 Demo Plugin 插件...");
    expect(note).toHaveBeenCalledWith("无法启用 Demo Plugin：blocked by allowlist。", "插件安装");
    expect(withPluginLifecycleLease).toHaveBeenCalledOnce();
  });

  it("refuses non-skipped installs in Nix mode before package work", async () => {
    vi.stubEnv("OPENCLAW_NIX_MODE", "1");
    await expect(
      ensureOnboardingPluginInstalled({
        cfg: {},
        entry: installEntry(
          {
            npmSpec: "@openclaw/demo-plugin@1.2.3",
          },
          { label: "Demo Provider" },
        ),
        promptInstall: false,
        prompter: {
          select: vi.fn(async () => "npm"),
          progress: vi.fn(),
        } as never,
        runtime: {} as never,
      }),
    ).rejects.toThrow("OPENCLAW_NIX_MODE=1");

    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(enablePluginInConfig).not.toHaveBeenCalled();
  });

  it("uses a guarded npm-pack install override for the matching plugin id", async () => {
    const archivePath = path.resolve("tmp/demo-plugin.tgz");
    const cfg = installPolicyConfig();
    process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
    process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
      "other-plugin": "npm:@demo/other@1.0.0",
      "demo-plugin": `npm-pack:${archivePath}`,
    });
    installPluginFromNpmPackArchive.mockResolvedValue({
      ok: true,
      pluginId: "demo-plugin",
      targetDir: "/tmp/openclaw/extensions/demo-plugin",
      version: "1.2.3",
      manifestName: "@demo/plugin",
      npmTarballName: "demo-plugin-1.2.3.tgz",
      npmResolution: {
        name: "@demo/plugin",
        version: "1.2.3",
        resolvedSpec: "file:demo-plugin-1.2.3.tgz",
        integrity: "sha512-demo",
        shasum: "abc123",
        resolvedAt: "2026-05-09T00:00:00.000Z",
      },
    });

    const select = vi.fn(async () => "npm");
    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: installEntry(
        {
          npmSpec: "@demo/plugin@1.2.3",
        },
        { trustedSourceLinkedOfficialInstall: true },
      ),
      prompter: {
        select,
        note: vi.fn(),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { log: vi.fn() } as never,
      workspaceDir: "/tmp/workspace",
    });

    expect(select).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    const [packCall] = readFirstMockCall(
      installPluginFromNpmPackArchive,
      "installPluginFromNpmPackArchive",
    ) as [NpmPackInstallCall];
    expect(packCall.archivePath).toBe(archivePath);
    expect(packCall.config).toBe(cfg);
    expect(packCall.expectedPluginId).toBe("demo-plugin");
    expect(packCall).not.toHaveProperty("trustedSourceLinkedOfficialInstall");
    const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
      OpenClawConfig,
      PluginInstallRecord,
    ];
    expect(recordUpdate).toEqual({
      pluginId: "demo-plugin",
      source: "npm",
      spec: "file:demo-plugin-1.2.3.tgz",
      sourcePath: archivePath,
      installPath: "/tmp/openclaw/extensions/demo-plugin",
      version: "1.2.3",
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmIntegrity: "sha512-demo",
      npmShasum: "abc123",
      npmTarballName: "demo-plugin-1.2.3.tgz",
    });
    expect(result.status).toBe("installed");
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
    expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.objectContaining({ warn: expect.any(Function) }),
      }),
    );
  });

  it("uses a guarded npm install override without official-trust flags", async () => {
    process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
    process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify({
      codex: "npm:@openclaw/codex@2026.5.8",
      "other-plugin": "npm-pack:/tmp/other.tgz",
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "codex",
      targetDir: "/tmp/openclaw/extensions/codex",
      version: "2026.5.8",
      npmResolution: {
        name: "@openclaw/codex",
        version: "2026.5.8",
        resolvedSpec: "@openclaw/codex@2026.5.8",
      },
    });

    await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry(
        {
          npmSpec: "@openclaw/codex",
        },
        { pluginId: "codex", label: "Codex", trustedSourceLinkedOfficialInstall: true },
      ),
      prompter: {
        select: vi.fn(async () => "npm"),
        note: vi.fn(),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { log: vi.fn() } as never,
    });

    const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
      NpmSpecInstallCall,
    ];
    expect(npmCall.trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(npmCall.spec).toBe("@openclaw/codex@2026.5.8");
    expect(npmCall.expectedPluginId).toBe("codex");
  });

  it.each([
    { beta: "2026.9.1-beta.1", latest: "2026.9.2", selected: "2026.9.2", spec: "@openclaw/codex" },
    {
      beta: "2026.9.3-beta.1",
      latest: "2026.9.2",
      selected: "2026.9.3-beta.1",
      spec: "@openclaw/codex@latest",
    },
  ])(
    "selects $selected before npm install and preserves $spec (beta=$beta)",
    async ({ beta, latest, selected, spec }) => {
      mockNpmChannelMetadata("@openclaw/codex", beta, latest);
      installPluginFromNpmSpec.mockResolvedValue({
        ok: true,
        pluginId: "codex",
        targetDir: "/tmp/openclaw/extensions/codex",
        version: selected,
        npmResolution: {
          name: "@openclaw/codex",
          version: selected,
          resolvedSpec: `@openclaw/codex@${selected}`,
        },
      });

      const result = await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "beta" } },
        entry: installEntry(
          { npmSpec: spec },
          { pluginId: "codex", label: "Codex", trustedSourceLinkedOfficialInstall: true },
        ),
        prompter: {
          select: vi.fn(async () => "npm"),
          note: vi.fn(),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: { log: vi.fn() } as never,
      });

      expect(installPluginFromNpmSpec).toHaveBeenCalledOnce();
      expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
        expect.objectContaining({ spec: `@openclaw/codex@${selected}` }),
      );
      expect(result.status).toBe("installed");
      expect(result.cfg.plugins?.installs?.codex?.spec).toBe(spec);
    },
  );

  it.each(["clawhub:demo-plugin@latest"])(
    "retries the operator ClawHub selector %s when no beta release is published",
    async (spec) => {
      installPluginFromClawHub
        .mockResolvedValueOnce({
          ok: false,
          code: "version_not_found",
          error: "Version not found on ClawHub: demo-plugin@beta.",
        })
        .mockResolvedValue({
          ok: true,
          pluginId: "demo-plugin",
          targetDir: "/tmp/demo-plugin",
          version: "2026.5.2",
          packageName: "demo-plugin",
          clawhub: clawHubRecord(),
        });
      const note = vi.fn();

      await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "beta" } } as never,
        entry: installEntry(
          { clawhubSpec: spec, defaultChoice: "clawhub" },
          { label: "Demo Provider" },
        ),
        prompter: {
          select: vi.fn(async () => "clawhub"),
          note,
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
      });

      const calls = installPluginFromClawHub.mock.calls as [{ spec?: string }][];
      expect(calls[0]?.[0]?.spec).toBe("clawhub:demo-plugin@beta");
      expect(calls[1]?.[0]?.spec).toBe(spec);
      expect(
        note.mock.calls.some(([message]) =>
          String(message).includes("No clawhub:demo-plugin@beta release is published"),
        ),
      ).toBe(true);
    },
  );

  it("installs and records ClawHub provider plugins with source facts", async () => {
    const cfg = installPolicyConfig();
    installPluginFromClawHub.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin from ClawHub…");
      return {
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: "2026.5.2",
        packageName: "demo-plugin",
        clawhub: clawHubRecord(),
      };
    });
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: installEntry(
        {
          clawhubSpec: "clawhub:demo-plugin@2026.5.2",
          npmSpec: "@openclaw/demo-plugin@2026.5.2",
          defaultChoice: "clawhub",
        },
        { label: "Demo Provider" },
      ),
      prompter: {
        select: vi.fn(async () => "clawhub"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: {} as never,
    });

    const [clawHubCall] = readFirstMockCall(
      installPluginFromClawHub,
      "installPluginFromClawHub",
    ) as [ClawHubInstallCall];
    expect(clawHubCall.spec).toBe("clawhub:demo-plugin@2026.5.2");
    expect(clawHubCall.config).toBe(cfg);
    expect(clawHubCall.expectedPluginId).toBe("demo-plugin");
    expect(clawHubCall.mode).toBe("install");
    expect(clawHubCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin from ClawHub…");
    expect(stop).toHaveBeenCalledWith("Installed Demo Provider plugin");
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.cfg.plugins?.installs?.["demo-plugin"]).toMatchObject({
      pluginId: "demo-plugin",
      source: "clawhub",
      spec: "clawhub:demo-plugin@2026.5.2",
      installPath: "/tmp/demo-plugin",
      version: "2026.5.2",
      integrity: "sha256-clawpack",
      clawhubPackage: "demo-plugin",
      clawpackSize: 4096,
    });
  });

  it("passes npm specs and optional expected integrity to npm installs with progress", async () => {
    const cfg = installPolicyConfig();
    const npmResolution = {
      name: "@wecom/wecom-openclaw-plugin",
      version: "1.2.3",
      resolvedSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
      integrity: "sha512-wecom",
      shasum: "deadbeef",
      resolvedAt: "2026-04-24T00:00:00.000Z",
    };
    const installFields = {
      resolvedName: npmResolution.name,
      resolvedVersion: npmResolution.version,
      resolvedSpec: npmResolution.resolvedSpec,
      integrity: npmResolution.integrity,
      shasum: npmResolution.shasum,
      resolvedAt: npmResolution.resolvedAt,
    };
    buildNpmResolutionInstallFields.mockReturnValueOnce(installFields);
    installPluginFromNpmSpec.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin…");
      return {
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: "1.2.3",
        npmResolution,
      };
    });
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: installEntry(
        {
          npmSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
          expectedIntegrity: "sha512-wecom",
        },
        { label: "WeCom", trustedSourceLinkedOfficialInstall: true },
      ),
      prompter: {
        select: vi.fn(async () => "npm"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: {} as never,
    });

    const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
      NpmSpecInstallCall,
    ];
    expect(npmCall.spec).toBe("@wecom/wecom-openclaw-plugin@1.2.3");
    expect(npmCall.config).toBe(cfg);
    expect(npmCall.mode).toBe("update");
    expect(npmCall.expectedPluginId).toBe("demo-plugin");
    expect(npmCall.expectedIntegrity).toBe("sha512-wecom");
    expect(npmCall.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(npmCall.timeoutMs).toBe(300_000);
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin…");
    expect(stop).toHaveBeenCalledWith("Installed WeCom plugin");
    expect(buildNpmResolutionInstallFields).toHaveBeenCalledWith(npmResolution);
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
    expect(result.cfg.plugins?.installs?.["demo-plugin"]).toMatchObject({
      pluginId: "demo-plugin",
      source: "npm",
      spec: "@wecom/wecom-openclaw-plugin@1.2.3",
      installPath: "/tmp/demo-plugin",
      version: "1.2.3",
      ...installFields,
    });
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
    expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        logger: expect.objectContaining({ warn: expect.any(Function) }),
      }),
    );
  });

  it.each(["@openclaw/discord@latest"])(
    "installs trusted official intent %s at the exact extended-stable core version",
    async (spec) => {
      coreVersion.value = "2026.7.33";
      installPluginFromNpmSpec.mockResolvedValueOnce({
        ok: true,
        pluginId: "discord",
        targetDir: "/tmp/discord",
        version: VERSION,
        npmResolution: {
          name: "@openclaw/discord",
          version: VERSION,
          resolvedSpec: `@openclaw/discord@${VERSION}`,
        },
      });

      await ensureOnboardingPluginInstalled({
        cfg: { update: { channel: "extended-stable" } },
        entry: installEntry(
          { npmSpec: spec },
          { pluginId: "discord", label: "Discord", trustedSourceLinkedOfficialInstall: true },
        ),
        prompter: {
          select: vi.fn(async () => "npm"),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.spec).toBe(`@openclaw/discord@${VERSION}`);
      const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(recordUpdate.spec).toBe(spec);
    },
  );

  it.each([
    {
      version: "2026.8.1",
      channel: undefined,
      installVersion: "2026.8.1",
      spec: "@openclaw/codex",
    },
    {
      version: "2026.8.1-2",
      channel: "stable",
      installVersion: "2026.8.1",
      spec: "@openclaw/codex@latest",
    },
    {
      version: "2026.7.33-1",
      channel: "extended-stable",
      installVersion: "2026.7.33",
      spec: "@openclaw/codex",
    },
    {
      version: "2026.8.1",
      channel: "beta",
      installVersion: "2026.8.2-beta.1",
      spec: "@openclaw/codex@latest",
    },
    {
      version: "2026.8.1-beta.4",
      channel: "stable",
      installVersion: "2026.8.2-beta.1",
      spec: "@openclaw/codex",
    },
  ] as const)(
    "applies the release policy to version-bound plugins from $spec on core $version with channel $channel",
    async ({ version, channel, installVersion, spec }) => {
      coreVersion.value = version;
      if (channel === "beta" || version.includes("beta")) {
        mockNpmChannelMetadata("@openclaw/codex", "2026.8.2-beta.1", "2026.8.1");
      }
      installPluginFromNpmSpec.mockResolvedValueOnce({
        ok: true,
        pluginId: "codex",
        targetDir: "/tmp/codex",
        version: installVersion,
        npmResolution: {
          name: "@openclaw/codex",
          version: installVersion,
          resolvedSpec: `@openclaw/codex@${installVersion}`,
        },
      });

      await ensureOnboardingPluginInstalled({
        cfg: channel ? { update: { channel } } : {},
        entry: installEntry(
          { npmSpec: spec },
          {
            pluginId: "codex",
            label: "Codex",
            trustedSourceLinkedOfficialInstall: true,
            versionBoundToOpenClaw: true,
          },
        ),
        prompter: {
          select: vi.fn(async () => "npm"),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.spec).toBe(`@openclaw/codex@${installVersion}`);
      const [, recordUpdate] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(recordUpdate.spec).toBe(spec);
    },
  );

  it("preserves npm install warnings in progress and logs them once", async () => {
    const warning =
      "npm rejected managed npm alias overrides; retrying plugin install without alias overrides for this npm version.";
    installPluginFromNpmSpec.mockImplementation(async (params) => {
      params.logger?.warn?.(warning);
      return {
        ok: true,
        pluginId: "codex",
        targetDir: "/tmp/openclaw/extensions/codex",
        version: "2026.5.10-beta.5",
      };
    });
    const log = vi.fn();
    const stop = vi.fn();
    const update = vi.fn();

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry(
        {
          npmSpec: "@openclaw/codex@beta",
        },
        { pluginId: "codex", label: "Codex" },
      ),
      prompter: {
        select: vi.fn(async () => "npm"),
        progress: vi.fn(() => ({ update, stop })),
      } as never,
      runtime: { log } as never,
    });

    expect(update).toHaveBeenCalledWith(warning);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(`${warning}\n`);
    expect(stop).toHaveBeenCalledWith("Installed Codex plugin");
    expect(result.status).toBe("installed");
  });

  it("cancels a timed out npm install before returning and releasing its lease", async () => {
    const note = vi.fn(async () => {});
    const stop = vi.fn();
    let installSignal: AbortSignal | undefined;
    let leaseActive = false;
    const cleanup = createDeferredCore();
    const aborted = createDeferredCore();
    withPluginLifecycleLease.mockImplementationOnce(async (_options, run) => {
      leaseActive = true;
      try {
        return await run();
      } finally {
        leaseActive = false;
      }
    });
    installPluginFromNpmSpec.mockImplementationOnce(async (params: { signal?: AbortSignal }) => {
      installSignal = params.signal;
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      await cleanup.promise;
      return { ok: false, error: "installer canceled" };
    });
    withTimeout.mockRejectedValue(new Error("timeout"));

    const pendingResult = ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry({
        npmSpec: "@demo/plugin@1.2.3",
        expectedIntegrity: "sha512-demo",
      }),
      prompter: {
        select: vi.fn(async () => "npm"),
        note,
        progress: vi.fn(() => ({ update: vi.fn(), stop })),
      } as never,
      runtime: {
        error: vi.fn(),
      } as never,
    });
    let returned = false;
    void pendingResult.then(() => {
      returned = true;
    });

    await aborted.promise;
    expect(installSignal?.aborted).toBe(true);
    expect(leaseActive).toBe(true);
    expect(returned).toBe(false);

    cleanup.resolve();
    const result = await pendingResult;

    expect(leaseActive).toBe(false);
    expect(result).toEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "timed_out",
    });
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).not.toHaveBeenCalled();
    expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith("Install timed out: Demo Plugin");
    expect(note).toHaveBeenCalledWith(
      "Installing @demo/plugin@1.2.3 timed out after 5 minutes.\nReturning to selection.",
      "Plugin install",
    );
  });

  it("offers floating npm specs on beta and skips without registry access", async () => {
    let captured: InstallPrompt | undefined;

    const result = await ensureOnboardingPluginInstalled({
      cfg: { update: { channel: "beta" } },
      entry: installEntry({
        npmSpec: "@demo/plugin",
      }),
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.options).toEqual([
      { value: "npm", label: "Download from npm (@demo/plugin)" },
      { value: "skip", label: "Skip for now" },
    ]);
    expect(captured?.initialValue).toBe("npm");
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
  });

  it("uses npm before historical ClawHub defaults for dual-source remote installs", async () => {
    let captured: InstallPrompt | undefined;

    await ensureOnboardingPluginInstalled({
      cfg: { update: { channel: "stable" } },
      entry: installEntry({
        clawhubSpec: "clawhub:demo-plugin@2026.5.2",
        npmSpec: "@openclaw/demo-plugin@2026.5.2",
        defaultChoice: "clawhub",
      }),
      prompter: {
        select: vi.fn(async (input) => {
          captured = input;
          return "skip";
        }),
      } as never,
      runtime: {} as never,
    });

    expect(captured?.initialValue).toBe("npm");
    expect(captured?.options).toEqual([
      { value: "npm", label: "Download from npm (@openclaw/demo-plugin@2026.5.2)" },
      { value: "clawhub", label: "Download from ClawHub (clawhub:demo-plugin@2026.5.2)" },
      { value: "skip", label: "Skip for now" },
    ]);
    expect(installPluginFromClawHub).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "explicit stable selector",
      version: "2026.8.1",
      npmSpec: "@openclaw/demo-plugin@2026.5.2",
      clawhubSpec: "clawhub:demo-plugin@2026.5.2",
      expectedNpmSpecs: ["@openclaw/demo-plugin@2026.5.2"],
      expectedClawHubSpec: "clawhub:demo-plugin@2026.5.2",
      installVersion: "2026.5.2",
      trustedSourceLinkedOfficialInstall: false,
    },
    {
      name: "official beta core",
      version: "2026.8.1-beta.3",
      npmSpec: "@openclaw/demo-plugin",
      clawhubSpec: "clawhub:demo-plugin",
      expectedNpmSpecs: ["@openclaw/demo-plugin@latest"],
      expectedClawHubSpec: "clawhub:demo-plugin@beta",
      installVersion: "2026.8.1-beta.3",
      trustedSourceLinkedOfficialInstall: true,
    },
  ])(
    "uses the declared ClawHub secondary when npm is absent ($name)",
    async ({
      version,
      npmSpec,
      clawhubSpec,
      expectedNpmSpecs,
      expectedClawHubSpec,
      installVersion,
      trustedSourceLinkedOfficialInstall,
    }) => {
      coreVersion.value = version;
      if (version.includes("beta")) {
        mockNpmChannelMetadata("@openclaw/demo-plugin", undefined, undefined);
      }
      for (const spec of expectedNpmSpecs) {
        installPluginFromNpmSpec.mockResolvedValueOnce({
          ok: false,
          code: "npm_package_not_found",
          error: `npm artifact absent: ${spec}`,
        });
      }
      installPluginFromClawHub.mockResolvedValueOnce({
        ok: true,
        pluginId: "demo-plugin",
        targetDir: "/tmp/demo-plugin",
        version: installVersion,
        clawhub: {
          source: "clawhub",
          clawhubPackage: "demo-plugin",
          version: installVersion,
        },
      });

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: installEntry(
          {
            clawhubSpec,
            npmSpec,
            defaultChoice: "clawhub",
          },
          { trustedSourceLinkedOfficialInstall },
        ),
        prompter: {
          select: vi.fn(async () => "clawhub"),
          confirm: vi.fn(async () => true),
          note: vi.fn(async () => {}),
          progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      const npmCalls = installPluginFromNpmSpec.mock.calls as [NpmSpecInstallCall][];
      expect(npmCalls.map(([call]) => call.spec)).toEqual(expectedNpmSpecs);
      const [npmCall] = readFirstMockCall(installPluginFromNpmSpec, "installPluginFromNpmSpec") as [
        NpmSpecInstallCall,
      ];
      expect(npmCall.expectedPluginId).toBe("demo-plugin");
      expect(installPluginFromClawHub).toHaveBeenCalledOnce();
      const [clawhubCall] = readFirstMockCall(
        installPluginFromClawHub,
        "installPluginFromClawHub",
      ) as [ClawHubInstallCall];
      expect(clawhubCall.spec).toBe(expectedClawHubSpec);
      expect(clawhubCall.expectedPluginId).toBe("demo-plugin");
      const [, record] = readFirstMockCall(recordPluginInstall, "recordPluginInstall") as [
        OpenClawConfig,
        PluginInstallRecord,
      ];
      expect(record.source).toBe("clawhub");
      expect(record.spec).toBe(clawhubSpec);
      expect(record.version).toBe(installVersion);
      expect(result.installed).toBe(true);
    },
  );

  it.each([
    {
      name: "non-OpenClaw package",
      npmSpec: "@someone-else/demo-plugin@2026.5.2",
      code: "artifact_download_unavailable",
      error: "ClawHub ClawPack artifact is unavailable.",
    },
    {
      name: "integrity refusal",
      npmSpec: "@openclaw/demo-plugin@2026.5.2",
      code: "archive_integrity_mismatch",
      error: "ClawHub ClawPack integrity mismatch.",
    },
  ])("does not fall back from ClawHub after $name", async ({ npmSpec, code, error }) => {
    const confirm = vi.fn(async () => true);
    const runtimeError = vi.fn();
    installPluginFromClawHub.mockResolvedValueOnce({ ok: false, code, error });
    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry({
        clawhubSpec: "clawhub:demo-plugin@2026.5.2",
        npmSpec,
        defaultChoice: "clawhub",
      }),
      prompter: {
        select: vi.fn(async () => "clawhub"),
        confirm,
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { error: runtimeError } as never,
      promptInstall: true,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(`Plugin install failed: ${error}`);
    expect(result).toStrictEqual({
      cfg: {},
      installed: false,
      pluginId: "demo-plugin",
      status: "failed",
      error,
    });
  });

  it("returns bounded multiline ClawHub failure detail to non-interactive callers", async () => {
    const runtimeError = vi.fn();
    const summaryPrefix = "x".repeat(178);
    installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "archive_integrity_mismatch",
      error: `Install failed: ${summaryPrefix}🚀tail\tvalue[31m\nsecond\tline\n${"y".repeat(20_000)}`,
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg: {},
      entry: installEntry({
        clawhubSpec: "clawhub:demo-plugin@2026.5.2",
        defaultChoice: "clawhub",
      }),
      prompter: {
        select: vi.fn(async () => "clawhub"),
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => {}),
        progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      } as never,
      runtime: { error: runtimeError } as never,
      promptInstall: false,
    });

    expect(result.error).toMatch(/^Install failed: x{178}🚀tail/);
    expect(result.error).toContain("\\tvalue");
    expect(result.error).toContain("\nsecond\\tline\n");
    expect(result.error).not.toContain("");
    expect(result.error?.endsWith("\n… (installer output truncated)")).toBe(true);
    expect(result.error?.length).toBe(12_000);
    const runtimeMessage = String(readFirstMockCall(runtimeError, "runtime.error")[0]);
    expect(runtimeMessage).toContain(`${summaryPrefix}…`);
    expect(runtimeMessage).not.toContain("");
  });

  it.each(["spoofed", "directory", "linked", "cwd", "outside"] as const)(
    "offers local paths only inside trusted %s workspaces",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-onboarding-local-choice-" }, async (temp) => {
        const workspaceDir = path.join(temp, "workspace");
        const cwdDir = path.join(temp, "cwd");
        const pluginDir = path.join(
          kind === "outside" ? temp : kind === "cwd" ? cwdDir : workspaceDir,
          "plugins",
          "demo",
        );
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(cwdDir, { recursive: true });
        await fs.mkdir(pluginDir, { recursive: true });
        const gitRoot = kind === "cwd" ? cwdDir : workspaceDir;
        if (kind === "spoofed") {
          await fs.writeFile(path.join(gitRoot, ".git"), "not-a-gitdir-pointer\n");
        } else if (kind === "linked") {
          const commonGitDir = path.join(temp, "repo.git");
          await fs.mkdir(commonGitDir);
          await fs.writeFile(
            path.join(gitRoot, ".git"),
            `gitdir: ${await fs.realpath(commonGitDir)}\n`,
          );
        } else {
          await fs.mkdir(path.join(gitRoot, ".git"));
        }
        const hasNpm = kind === "directory";
        const allowed = kind !== "spoofed" && kind !== "outside";
        let captured: InstallPrompt | undefined;
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        try {
          const result = await ensureOnboardingPluginInstalled({
            cfg: {},
            entry: {
              pluginId: "demo-plugin",
              label: hasNpm ? "Demo\x1b[31m Plugin\n" : "Demo Plugin",
              install: {
                localPath: kind === "cwd" || kind === "outside" ? pluginDir : "plugins/demo",
                ...(hasNpm
                  ? { npmSpec: "@demo/plugin@1.2.3", expectedIntegrity: "sha512-demo" }
                  : {}),
              },
            },
            prompter: {
              select: vi.fn(async (input) => {
                captured = input;
                return "skip";
              }),
            } as never,
            runtime: {} as never,
            workspaceDir,
          });
          expect(result).toEqual({
            cfg: {},
            installed: false,
            pluginId: "demo-plugin",
            status: "skipped",
          });
        } finally {
          cwdSpy.mockRestore();
        }
        const prompt = requireCapturedPrompt(captured);
        expect(prompt.message).toBe(
          hasNpm ? "Install Demo Plugin\\n plugin?" : "Install Demo Plugin plugin?",
        );
        expect(prompt.options).toEqual([
          ...(hasNpm ? [{ value: "npm", label: "Download from npm (@demo/plugin@1.2.3)" }] : []),
          ...(allowed
            ? [
                {
                  value: "local",
                  label: "Use local plugin path",
                  hint: await fs.realpath(pluginDir),
                },
              ]
            : []),
          { value: "skip", label: "Skip for now" },
        ]);
        expect(prompt.initialValue).toBe(hasNpm ? "npm" : allowed ? "local" : "skip");
        expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
      });
    },
  );

  it("does not add local plugin paths when enablement is blocked by policy", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-blocked-enable-" }, async (temp) => {
      const workspaceDir = path.join(temp, "workspace");
      const pluginDir = path.join(workspaceDir, "plugins", "demo");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      enablePluginInConfig.mockReturnValueOnce({
        config: {},
        enabled: false,
        pluginId: "demo",
        reason: "blocked by allowlist",
      });
      const note = vi.fn(async () => {});
      const error = vi.fn();

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: installEntry({
          localPath: "plugins/demo",
        }),
        prompter: {
          select: vi.fn(async () => "local"),
          note,
        } as never,
        runtime: { error } as never,
        workspaceDir,
      });

      expect(result).toEqual({
        cfg: {},
        installed: false,
        pluginId: "demo-plugin",
        status: "failed",
      });
      expect(note).toHaveBeenCalledWith(
        "Cannot enable Demo Plugin: blocked by allowlist.",
        "Plugin install",
      );
      expect(error).toHaveBeenCalledWith(
        "Plugin install failed: demo-plugin is disabled (blocked by allowlist).",
      );
    });
  });

  it.each([
    {
      name: "beta selection",
      beta: true,
      fallback: false,
      absolute: false,
      npmSpec: "@demo/plugin",
    },
    {
      name: "npm fallback",
      beta: false,
      fallback: true,
      absolute: false,
      npmSpec: "@demo/plugin@1.2.3",
    },
    {
      name: "absolute catalog path",
      beta: false,
      fallback: false,
      absolute: true,
      npmSpec: undefined,
    },
  ])(
    "records portable local install metadata for $name",
    async ({ beta, fallback, absolute, npmSpec }) => {
      await withTestDir({ prefix: "openclaw-onboarding-local-record-" }, async (temp) => {
        const workspaceDir = path.join(temp, "workspace");
        const pluginDir = path.join(workspaceDir, "plugins", "demo");
        await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
        await fs.mkdir(pluginDir, { recursive: true });
        const realPluginDir = await fs.realpath(pluginDir);
        if (fallback) {
          installPluginFromNpmSpec.mockResolvedValueOnce({
            ok: false,
            code: "npm_package_not_found",
            error: "registry unavailable",
          });
        }
        const note = vi.fn(async () => {});
        const cfg: OpenClawConfig = beta ? { update: { channel: "beta" } } : {};
        const result = await ensureOnboardingPluginInstalled({
          cfg,
          entry: installEntry({
            localPath: absolute ? realPluginDir : "plugins/demo",
            ...(npmSpec ? { npmSpec } : {}),
          }),
          prompter: fallback
            ? ({
                select: vi.fn(async () => "npm"),
                note,
                confirm: vi.fn(async () => true),
                progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
              } as never)
            : ({ select: vi.fn(async () => "local") } as never),
          runtime: {} as never,
          workspaceDir,
        });
        if (fallback) {
          expect(note).toHaveBeenCalledWith(
            "Failed to install @demo/plugin@1.2.3: registry unavailable\nReturning to selection.",
            "Plugin install",
          );
        }
        expect(result.installed).toBe(true);
        expect(result.status).toBe("installed");
        expect(result.cfg).toEqual({
          ...cfg,
          plugins: {
            load: { paths: [realPluginDir] },
            installs: {
              "demo-plugin": {
                pluginId: "demo-plugin",
                source: "path",
                installPath: realPluginDir,
                sourcePath: "./plugins/demo",
                ...(npmSpec ? { spec: npmSpec } : {}),
              },
            },
          },
        });
        expect(runCommandWithTimeout).not.toHaveBeenCalled();
        expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
        expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
        expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
          expect.objectContaining({
            logger: expect.objectContaining({ warn: expect.any(Function) }),
          }),
        );
      });
    },
  );

  it("hides the npm download option for bundled plugins so the menu matches non-npm channels", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-bundled-prompt-" }, async (temp) => {
      const bundledDir = path.join(temp, "dist", "extensions", "tlon");
      await fs.mkdir(bundledDir, { recursive: true });
      const realBundledDir = await fs.realpath(bundledDir);
      resolveBundledInstallPlanForCatalogEntry.mockReturnValue({
        bundledSource: { localPath: realBundledDir },
      });
      findBundledPluginSourceInMap.mockReturnValue({ localPath: realBundledDir });

      let captured: InstallPrompt | undefined;

      await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: installEntry(
          {
            npmSpec: "@openclaw/tlon",
            defaultChoice: "npm",
          },
          { pluginId: "tlon", label: "Tlon" },
        ),
        prompter: {
          select: vi.fn(async (input) => {
            captured = input;
            return "skip";
          }),
        } as never,
        runtime: {} as never,
      });

      const prompt = requireCapturedPrompt(captured);
      expect(prompt.options).toEqual([
        {
          value: "local",
          label: "Use local plugin path",
          hint: realBundledDir,
        },
        { value: "skip", label: "Skip for now" },
      ]);
      expect(prompt.initialValue).toBe("local");
      findBundledPluginSourceInMap.mockReset();
      resolveBundledInstallPlanForCatalogEntry.mockReset();
    });
  });

  it("enables bundled plugins without adding their bundled directory as a local install", async () => {
    await withTestDir({ prefix: "openclaw-onboarding-install-bundled-record-" }, async (temp) => {
      const bundledDir = path.join(temp, "dist", "extensions", "discord");
      await fs.mkdir(bundledDir, { recursive: true });
      const realBundledDir = await fs.realpath(bundledDir);
      resolveBundledInstallPlanForCatalogEntry.mockReturnValueOnce({
        bundledSource: {
          localPath: realBundledDir,
        },
      });
      enablePluginInConfig.mockReturnValueOnce({
        config: {
          plugins: {
            entries: {
              discord: { enabled: true },
            },
          },
        },
        enabled: true,
        pluginId: "discord",
      });

      const result = await ensureOnboardingPluginInstalled({
        cfg: {},
        entry: installEntry(
          {
            npmSpec: "@openclaw/discord",
          },
          { pluginId: "discord", label: "Discord" },
        ),
        prompter: {
          select: vi.fn(async () => "local"),
        } as never,
        runtime: {} as never,
        promptInstall: false,
      });

      expect(result.installed).toBe(true);
      expect(result.cfg.plugins?.entries?.discord?.enabled).toBe(true);
      expect(result.cfg.plugins?.load?.paths).toBeUndefined();
      expect(result.cfg.plugins?.installs).toBeUndefined();
      expect(recordPluginInstall).not.toHaveBeenCalled();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
