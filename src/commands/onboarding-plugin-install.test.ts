import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord as PersistedPluginInstallRecord } from "../config/types.plugins.js";
import type { PluginEnableResult } from "../plugins/enable.js";
import { installPluginDirectoryIntoExtensions } from "../plugins/install-shared.js";
import type { PluginInstallUpdate } from "../plugins/installs.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
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

const installers = vi.hoisted(() => ({
  npm: vi.fn<(params: NpmSpecInstallCall) => Promise<unknown>>(),
  archive: vi.fn<(params: NpmPackInstallCall) => Promise<unknown>>(),
  clawhub: vi.fn<(params: ClawHubInstallCall) => Promise<unknown>>(),
}));
const runCommandWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout,
}));
// mock-isolation: onboarding exercises install decisions without installing packages.
vi.mock("../plugins/install.js", () => ({
  installPluginFromNpmSpec: installers.npm,
  installPluginFromNpmPackArchive: installers.archive,
}));

// mock-isolation: package lookup and installation use fixtures instead of the live registry.
vi.mock("../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
  },
  installPluginFromClawHub: installers.clawhub,
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
  vi.fn((cfg: OpenClawConfig, update: PluginInstallUpdate) => ({
    ...cfg,
    plugins: { ...cfg.plugins, installs: { ...cfg.plugins?.installs, [update.pluginId]: update } },
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
vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
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
import { ensureOnboardingPluginInstalled } from "./onboarding-plugin-install.js";
import {
  clawHubRecord,
  installEntry,
  installedPlugin,
  installPolicyConfig,
  notInstalled,
} from "./onboarding-plugin-install.test-fixtures.js";
import type { OnboardingPluginInstallOptions } from "./onboarding-plugin-install.types.js";

function runInstall(
  entry: OnboardingPluginInstallOptions["entry"],
  prompter: OnboardingPluginInstallOptions["prompter"],
  options: Partial<Omit<OnboardingPluginInstallOptions, "entry" | "prompter">> = {},
) {
  return ensureOnboardingPluginInstalled({
    cfg: {},
    runtime: {} as never,
    ...options,
    entry,
    prompter,
  });
}

function progress(update = vi.fn(), stop = vi.fn()) {
  return vi.fn(() => ({ update, stop }));
}

function choose(
  choice: InstallChoice,
  prompts: Partial<OnboardingPluginInstallOptions["prompter"]> = {},
) {
  return { select: vi.fn(async () => choice), ...prompts } as never;
}

function clawHubPrompter(confirm = vi.fn(async () => true)) {
  return choose("clawhub", { confirm, note: vi.fn(async () => {}), progress: progress() });
}

function installOverrides(...entries: Array<[string, string]>) {
  process.env.OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES = "1";
  process.env.OPENCLAW_PLUGIN_INSTALL_OVERRIDES = JSON.stringify(Object.fromEntries(entries));
}

function expectDiscoveryInvalidated() {
  expect(clearLoadInstalledPluginIndexInstallRecordsCache).toHaveBeenCalledOnce();
  expect(clearPluginMetadataLifecycleCaches).toHaveBeenCalledOnce();
  expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).toHaveBeenCalledWith(
    expect.objectContaining({ logger: expect.objectContaining({ warn: expect.any(Function) }) }),
  );
}

function requireCapturedPrompt<T>(captured: T | undefined): T {
  if (!captured) {
    throw new Error("expected captured install prompt");
  }
  return captured;
}

type InstallChoice = "clawhub" | "npm" | "local" | "skip";
type InstallPrompt = Parameters<OnboardingPluginInstallOptions["prompter"]["select"]>[0];

function firstCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T {
  return requireCapturedPrompt(mock.mock.calls[0]);
}

type NpmPackInstallCall = Parameters<
  typeof import("../plugins/install.js").installPluginFromNpmPackArchive
>[0];
type NpmSpecInstallCall = Parameters<
  typeof import("../plugins/install.js").installPluginFromNpmSpec
>[0];
type ClawHubInstallCall = Parameters<
  typeof import("../plugins/clawhub.js").installPluginFromClawHub
>[0];

function npmCall() {
  return firstCall(installers.npm)[0];
}

function installRecord() {
  return firstCall(recordPluginInstall)[1];
}

type ConsentScenario = {
  source: "npm-pack" | "local" | "npm" | "clawhub";
  accepted?: boolean;
  official?: boolean;
  promptError?: Error;
};

async function useArtifactConsent() {
  const actual = await vi.importActual<typeof import("../plugins/capability-consent.js")>(
    "../plugins/capability-consent.js",
  );
  prepareManagedPluginArtifactConsentHandler.mockImplementationOnce(
    actual.prepareManagedPluginArtifactConsentHandler,
  );
}

const skipOption = { value: "skip", label: "Skip for now" };
function localOption(hint: string) {
  return { value: "local", label: "Use local plugin path", hint };
}

async function localWorkspace(root: string) {
  const workspaceDir = path.join(root, "workspace");
  const pluginDir = path.join(workspaceDir, "plugins", "demo");
  await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  return { workspaceDir, realPluginDir: await fs.realpath(pluginDir) };
}

async function bundledDirectory(root: string, pluginId: string) {
  const dir = path.join(root, "dist", "extensions", pluginId);
  await fs.mkdir(dir, { recursive: true });
  return fs.realpath(dir);
}

function blockEnablement(pluginId: string) {
  enablePluginInConfig.mockReturnValueOnce({
    config: {},
    enabled: false,
    pluginId,
    reason: "blocked by allowlist",
  });
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

  it("reports only installer activity while npm is pending", async () => {
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
    installers.npm.mockImplementationOnce(install);
    const pending = runInstall(
      installEntry({ npmSpec: "@demo/plugin@1.0.0" }),
      { progress: progress(update, stop), note: vi.fn(async () => {}) } as never,
      { runtime: { log: vi.fn(), error: vi.fn() } as never, promptInstall: false },
    );
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
  });

  it.each<ConsentScenario>([
    ...(["npm-pack", "local"] as const).flatMap((source) =>
      [false, true].map((accepted) => ({ source, accepted })),
    ),
    { source: "clawhub" },
    ...(["npm", "clawhub"] as const).map((source) => ({ source, official: true })),
    { source: "local", promptError: new WizardNavigationError("back") },
    ...(["npm", "clawhub"] as const).map((source) => ({
      source,
      promptError: new Error("capability review guard rejected the operation"),
    })),
  ])(
    "reviews $source artifact capabilities before onboarding activation, official=$official accepted=$accepted promptError=$promptError",
    async ({ source, accepted = false, promptError, official = false }) => {
      const consentRequired = !official;
      const shouldInstall = !consentRequired || accepted;
      await useArtifactConsent();
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
        const install = async (
          params: Pick<NpmSpecInstallCall, "onBeforePluginArtifactCommit">,
        ) => {
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
          installOverrides(["demo-plugin", `npm-pack:${path.join(artifactDir, "plugin.tgz")}`]);
          installers.archive.mockImplementationOnce(install);
        } else if (source === "clawhub") {
          installers.clawhub.mockImplementationOnce(install);
        } else if (source === "npm") {
          installers.npm.mockImplementationOnce(install);
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
        const pending = runInstall(
          installEntry(
            source === "local"
              ? { localPath: artifactDir }
              : source === "clawhub"
                ? { clawhubSpec }
                : { npmSpec },
            { pluginId },
          ),
          { confirm, note, progress: progress() } as never,
          {
            cfg,
            runtime: { log, error: vi.fn() } as never,
            promptInstall: false,
            workspaceDir: artifactDir,
            beforePersistentEffect,
          },
        );
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
      await useArtifactConsent();
      await withTestDir({ prefix: "openclaw-hosted-install-consent-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "installed", "demo-plugin");
        await fs.mkdir(sourceDir);
        createColdPluginFixture({ rootDir: sourceDir, pluginId: "demo-plugin" });
        const committed = createDeferredCore();
        const releaseInstaller = createDeferredCore();
        installers.npm.mockImplementationOnce(async (params) => {
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
        });
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
                entry: installEntry(install, { label: "Demo plugin" }),
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

  it("localizes plugin install progress and enablement failures", async () => {
    vi.stubEnv("OPENCLAW_LOCALE", "zh-CN");
    blockEnablement("demo-plugin");
    installers.npm.mockResolvedValueOnce(installedPlugin({}));
    const note = vi.fn(async () => {});
    const installProgress = progress();

    await runInstall(
      installEntry({ npmSpec: "@demo/plugin@1.2.3" }),
      choose("npm", { note, progress: installProgress }),
      { runtime: { error: vi.fn() } as never },
    );

    expect(installProgress).toHaveBeenCalledWith("正在安装 Demo Plugin 插件...");
    expect(note).toHaveBeenCalledWith("无法启用 Demo Plugin：blocked by allowlist。", "插件安装");
    expect(withPluginLifecycleLease).toHaveBeenCalledOnce();
  });

  it("refuses non-skipped installs in Nix mode before package work", async () => {
    vi.stubEnv("OPENCLAW_NIX_MODE", "1");
    await expect(
      runInstall(
        installEntry({ npmSpec: "@openclaw/demo-plugin@1.2.3" }, { label: "Demo Provider" }),
        choose("npm", { progress: vi.fn() }),
        { promptInstall: false },
      ),
    ).rejects.toThrow("OPENCLAW_NIX_MODE=1");

    expect(installers.npm).not.toHaveBeenCalled();
    expect(installers.clawhub).not.toHaveBeenCalled();
    expect(enablePluginInConfig).not.toHaveBeenCalled();
  });

  it.each(["npm-pack", "npm"] as const)(
    "uses a guarded %s override without catalog trust",
    async (kind) => {
      const archivePath = path.resolve("tmp/demo-plugin.tgz");
      const spec = "@openclaw/demo-plugin@2026.5.8";
      const cfg = installPolicyConfig();
      installOverrides(
        ["other-plugin", "npm:@demo/other@1.0.0"],
        ["demo-plugin", kind === "npm-pack" ? `npm-pack:${archivePath}` : `npm:${spec}`],
      );
      const installer = kind === "npm-pack" ? installers.archive : installers.npm;
      installer.mockResolvedValue(
        installedPlugin({
          targetDir: "/tmp/openclaw/extensions/demo-plugin",
          npmTarballName: "demo-plugin-1.2.3.tgz",
          npmResolution: {
            resolvedSpec: "file:demo-plugin-1.2.3.tgz",
            integrity: "sha512-demo",
            shasum: "abc123",
          },
        }),
      );

      const select = vi.fn(async () => "npm");
      const result = await runInstall(
        installEntry(
          { npmSpec: "@demo/plugin@1.2.3" },
          { trustedSourceLinkedOfficialInstall: true },
        ),
        { select, note: vi.fn(), progress: progress() } as never,
        { cfg, runtime: { log: vi.fn() } as never, workspaceDir: "/tmp/workspace" },
      );

      expect(select).not.toHaveBeenCalled();
      expect(kind === "npm-pack" ? installers.npm : installers.archive).not.toHaveBeenCalled();
      const call = requireCapturedPrompt(installer.mock.calls[0]?.[0]);
      expect(call).toMatchObject({
        ...(kind === "npm-pack" ? { archivePath } : { spec }),
        expectedPluginId: "demo-plugin",
      });
      expect(call.config).toBe(cfg);
      expect(call).not.toHaveProperty("trustedSourceLinkedOfficialInstall");
      expect(installRecord()).toEqual({
        pluginId: "demo-plugin",
        source: "npm",
        spec: kind === "npm-pack" ? "file:demo-plugin-1.2.3.tgz" : spec,
        installPath: "/tmp/openclaw/extensions/demo-plugin",
        version: "1.2.3",
        ...(kind === "npm-pack"
          ? {
              sourcePath: archivePath,
              artifactKind: "npm-pack",
              artifactFormat: "tgz",
              npmIntegrity: "sha512-demo",
              npmShasum: "abc123",
              npmTarballName: "demo-plugin-1.2.3.tgz",
            }
          : {}),
      });
      expect(result.status).toBe("installed");
      expectDiscoveryInvalidated();
    },
  );

  it("retries the operator ClawHub selector when no beta release is published", async () => {
    const spec = "clawhub:demo-plugin@latest";
    installers.clawhub
      .mockResolvedValueOnce({
        ok: false,
        code: "version_not_found",
        error: "Version not found on ClawHub: demo-plugin@beta.",
      })
      .mockResolvedValue(
        installedPlugin({
          version: "2026.5.2",
          packageName: "demo-plugin",
          clawhub: clawHubRecord(),
        }),
      );
    const note = vi.fn();

    await runInstall(
      installEntry({ clawhubSpec: spec, defaultChoice: "clawhub" }, { label: "Demo Provider" }),
      choose("clawhub", { note, progress: progress() }),
      { cfg: { update: { channel: "beta" } } },
    );

    const calls = installers.clawhub.mock.calls;
    expect(calls[0]?.[0]?.spec).toBe("clawhub:demo-plugin@beta");
    expect(calls[1]?.[0]?.spec).toBe(spec);
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No clawhub:demo-plugin@beta release is published"),
      ),
    ).toBe(true);
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
    const { name: resolvedName, version: resolvedVersion, ...resolution } = npmResolution;
    const installFields = { resolvedName, resolvedVersion, ...resolution };
    buildNpmResolutionInstallFields.mockReturnValueOnce(installFields);
    installers.npm.mockImplementation(async (params) => {
      params.logger?.info?.("Downloading demo-plugin…");
      return installedPlugin({ npmResolution });
    });
    const stop = vi.fn();
    const update = vi.fn();

    const result = await runInstall(
      installEntry(
        { npmSpec: "@wecom/wecom-openclaw-plugin@1.2.3", expectedIntegrity: "sha512-wecom" },
        { label: "WeCom", trustedSourceLinkedOfficialInstall: true },
      ),
      choose("npm", { progress: progress(update, stop) }),
      { cfg },
    );

    expect(npmCall()).toMatchObject({
      spec: "@wecom/wecom-openclaw-plugin@1.2.3",
      mode: "update",
      expectedPluginId: "demo-plugin",
      expectedIntegrity: "sha512-wecom",
      trustedSourceLinkedOfficialInstall: true,
      timeoutMs: 300_000,
    });
    expect(npmCall().config).toBe(cfg);
    expect(update).toHaveBeenCalledWith("Downloading demo-plugin…");
    expect(stop).toHaveBeenCalledWith("Installed WeCom plugin");
    expect(buildNpmResolutionInstallFields).toHaveBeenCalledWith(npmResolution);
    expect(result).toMatchObject({ installed: true, status: "installed" });
    expect(result.cfg.plugins?.installs?.["demo-plugin"]).toMatchObject({
      pluginId: "demo-plugin",
      source: "npm",
      spec: "@wecom/wecom-openclaw-plugin@1.2.3",
      installPath: "/tmp/demo-plugin",
      version: "1.2.3",
      ...installFields,
    });
    expectDiscoveryInvalidated();
  });

  it("preserves npm install warnings in progress and logs them once", async () => {
    const warning =
      "npm rejected managed npm alias overrides; retrying plugin install without alias overrides for this npm version.";
    installers.npm.mockImplementation(async (params) => {
      params.logger?.warn?.(warning);
      return installedPlugin({
        pluginId: "codex",
        targetDir: "/tmp/openclaw/extensions/codex",
        version: "2026.5.10-beta.5",
      });
    });
    const log = vi.fn();
    const stop = vi.fn();
    const update = vi.fn();

    const result = await runInstall(
      installEntry({ npmSpec: "@openclaw/codex@beta" }, { pluginId: "codex", label: "Codex" }),
      choose("npm", { progress: progress(update, stop) }),
      { runtime: { log } as never },
    );

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
    installers.npm.mockImplementationOnce(async (params: { signal?: AbortSignal }) => {
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

    const pendingResult = runInstall(
      installEntry({ npmSpec: "@demo/plugin@1.2.3", expectedIntegrity: "sha512-demo" }),
      choose("npm", { note, progress: progress(vi.fn(), stop) }),
      { runtime: { error: vi.fn() } as never },
    );
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
    expect(result).toEqual(notInstalled("timed_out"));
    expect(clearLoadInstalledPluginIndexInstallRecordsCache).not.toHaveBeenCalled();
    expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
    expect(invalidatePluginRuntimeDiscoveryAfterConfigMutation).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith("Install timed out: Demo Plugin");
    expect(note).toHaveBeenCalledWith(
      "Installing @demo/plugin@1.2.3 timed out after 5 minutes.\nReturning to selection.",
      "Plugin install",
    );
  });

  it("uses the declared ClawHub secondary when npm is absent on official beta core", async () => {
    const installVersion = "2026.8.1-beta.3";
    const clawhubSpec = "clawhub:demo-plugin";
    coreVersion.value = installVersion;
    runCommandWithTimeout
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "npm error code E404" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "npm error code E404" });
    installers.npm.mockResolvedValueOnce({
      ok: false,
      code: "npm_package_not_found",
      error: "npm artifact absent: @openclaw/demo-plugin@latest",
    });
    installers.clawhub.mockResolvedValueOnce(
      installedPlugin({
        version: installVersion,
        clawhub: {
          source: "clawhub",
          clawhubPackage: "demo-plugin",
          version: installVersion,
        },
      }),
    );

    const result = await runInstall(
      installEntry(
        { clawhubSpec, npmSpec: "@openclaw/demo-plugin", defaultChoice: "clawhub" },
        { trustedSourceLinkedOfficialInstall: true },
      ),
      clawHubPrompter(),
      { promptInstall: false },
    );

    const npmCalls = installers.npm.mock.calls;
    expect(npmCalls.map(([call]) => call.spec)).toEqual(["@openclaw/demo-plugin@latest"]);
    expect(npmCall().expectedPluginId).toBe("demo-plugin");
    expect(installers.clawhub).toHaveBeenCalledOnce();
    const [clawhubCall] = firstCall(installers.clawhub);
    expect(clawhubCall).toMatchObject({
      spec: "clawhub:demo-plugin@beta",
      expectedPluginId: "demo-plugin",
    });
    expect(installRecord()).toMatchObject({
      source: "clawhub",
      spec: clawhubSpec,
      version: installVersion,
    });
    expect(result.installed).toBe(true);
  });

  it("does not fall back from ClawHub after integrity refusal", async () => {
    const error = "ClawHub ClawPack integrity mismatch.";
    const confirm = vi.fn(async () => true);
    const runtimeError = vi.fn();
    installers.clawhub.mockResolvedValueOnce({
      ok: false,
      code: "archive_integrity_mismatch",
      error,
    });
    const result = await runInstall(
      installEntry({
        clawhubSpec: "clawhub:demo-plugin@2026.5.2",
        npmSpec: "@openclaw/demo-plugin@2026.5.2",
        defaultChoice: "clawhub",
      }),
      clawHubPrompter(confirm),
      { runtime: { error: runtimeError } as never, promptInstall: true },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(installers.npm).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(`Plugin install failed: ${error}`);
    expect(result).toStrictEqual(notInstalled("failed", { error }));
  });

  it("returns bounded multiline ClawHub failure detail to non-interactive callers", async () => {
    const runtimeError = vi.fn();
    const summaryPrefix = "x".repeat(178);
    installers.clawhub.mockResolvedValueOnce({
      ok: false,
      code: "archive_integrity_mismatch",
      error: `Install failed: ${summaryPrefix}🚀tail\tvalue[31m\nsecond\tline\n${"y".repeat(20_000)}`,
    });

    const result = await runInstall(
      installEntry({
        clawhubSpec: "clawhub:demo-plugin@2026.5.2",
        defaultChoice: "clawhub",
      }),
      clawHubPrompter(),
      { runtime: { error: runtimeError } as never, promptInstall: false },
    );

    expect(result.error).toMatch(/^Install failed: x{178}🚀tail/);
    expect(result.error).toContain("\\tvalue");
    expect(result.error).toContain("\nsecond\\tline\n");
    expect(result.error).not.toContain("");
    expect(result.error?.endsWith("\n… (installer output truncated)")).toBe(true);
    expect(result.error?.length).toBe(12_000);
    const runtimeMessage = String(firstCall(runtimeError)[0]);
    expect(runtimeMessage).toContain(`${summaryPrefix}…`);
    expect(runtimeMessage).not.toContain("");
  });

  it.each(["spoofed", "linked", "outside", "symlink"] as const)(
    "offers local paths only inside trusted %s workspaces",
    (kind) =>
      withTestDir({ prefix: "openclaw-onboarding-local-choice-" }, async (temp) => {
        const workspaceDir = path.join(temp, "workspace");
        const cwdDir = path.join(temp, "cwd");
        const outside = kind === "outside" || kind === "symlink";
        const pluginDir = path.join(outside ? temp : workspaceDir, "plugins", "demo");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(cwdDir, { recursive: true });
        await fs.mkdir(pluginDir, { recursive: true });
        if (kind === "symlink") {
          await fs.symlink(path.join(temp, "plugins"), path.join(workspaceDir, "plugins"), "dir");
        }
        const gitRoot = workspaceDir;
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
        const hasNpm = kind === "linked";
        const allowed = kind !== "spoofed" && !outside;
        const select = vi.fn(async (_input: InstallPrompt) => "skip");
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        try {
          const result = await runInstall(
            installEntry(
              {
                localPath: kind === "outside" ? pluginDir : "plugins/demo",
                ...(hasNpm
                  ? { npmSpec: "@demo/plugin@1.2.3", expectedIntegrity: "sha512-demo" }
                  : {}),
              },
              { label: hasNpm ? "Demo\x1b[31m Plugin\n" : "Demo Plugin" },
            ),
            { select } as never,
            { workspaceDir },
          );
          expect(result).toEqual(notInstalled("skipped"));
        } finally {
          cwdSpy.mockRestore();
        }
        const prompt = firstCall(select)[0];
        expect(prompt.message).toBe(
          hasNpm ? "Install Demo Plugin\\n plugin?" : "Install Demo Plugin plugin?",
        );
        expect(prompt.options).toEqual([
          ...(hasNpm ? [{ value: "npm", label: "Download from npm (@demo/plugin@1.2.3)" }] : []),
          ...(allowed ? [localOption(await fs.realpath(pluginDir))] : []),
          skipOption,
        ]);
        expect(prompt.initialValue).toBe(hasNpm ? "npm" : allowed ? "local" : "skip");
        expect(clearPluginMetadataLifecycleCaches).not.toHaveBeenCalled();
      }),
  );

  it("does not add local plugin paths when enablement is blocked by policy", () =>
    withTestDir({ prefix: "openclaw-onboarding-install-blocked-enable-" }, async (temp) => {
      const { workspaceDir } = await localWorkspace(temp);
      blockEnablement("demo");
      const note = vi.fn(async () => {});
      const error = vi.fn();

      const result = await runInstall(
        installEntry({ localPath: "plugins/demo" }),
        choose("local", { note }),
        { runtime: { error } as never, workspaceDir },
      );

      expect(result).toEqual(notInstalled("failed"));
      expect(note).toHaveBeenCalledWith(
        "Cannot enable Demo Plugin: blocked by allowlist.",
        "Plugin install",
      );
      expect(error).toHaveBeenCalledWith(
        "Plugin install failed: demo-plugin is disabled (blocked by allowlist).",
      );
    }));

  it.each([
    ["beta selection", true, false, "@demo/plugin"],
    ["npm fallback", false, true, "@demo/plugin@1.2.3"],
  ] as const)("records portable local install metadata for %s", (_name, beta, fallback, npmSpec) =>
    withTestDir({ prefix: "openclaw-onboarding-local-record-" }, async (temp) => {
      const { workspaceDir, realPluginDir } = await localWorkspace(temp);
      if (fallback) {
        installers.npm.mockResolvedValueOnce({
          ok: false,
          code: "npm_package_not_found",
          error: "registry unavailable",
        });
      }
      const note = vi.fn(async () => {});
      const cfg: OpenClawConfig = beta ? { update: { channel: "beta" } } : {};
      const result = await runInstall(
        installEntry({
          localPath: "plugins/demo",
          npmSpec,
        }),
        fallback
          ? choose("npm", { note, confirm: vi.fn(async () => true), progress: progress() })
          : choose("local"),
        { cfg, workspaceDir },
      );
      if (fallback) {
        expect(note).toHaveBeenCalledWith(
          "Failed to install @demo/plugin@1.2.3: registry unavailable\nReturning to selection.",
          "Plugin install",
        );
      }
      expect(result).toMatchObject({ installed: true, status: "installed" });
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
              spec: npmSpec,
            },
          },
        },
      });
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
      expectDiscoveryInvalidated();
    }),
  );

  it("hides the npm download option for bundled plugins so the menu matches non-npm channels", () =>
    withTestDir({ prefix: "openclaw-onboarding-install-bundled-prompt-" }, async (temp) => {
      const realBundledDir = await bundledDirectory(temp, "tlon");
      resolveBundledInstallPlanForCatalogEntry.mockReturnValue({
        bundledSource: { localPath: realBundledDir },
      });
      findBundledPluginSourceInMap.mockReturnValue({ localPath: realBundledDir });

      const select = vi.fn(async (_input: InstallPrompt) => "skip");

      await runInstall(
        installEntry(
          { npmSpec: "@openclaw/tlon", defaultChoice: "npm" },
          { pluginId: "tlon", label: "Tlon" },
        ),
        { select } as never,
      );

      const prompt = firstCall(select)[0];
      expect(prompt.options).toEqual([localOption(realBundledDir), skipOption]);
      expect(prompt.initialValue).toBe("local");
      findBundledPluginSourceInMap.mockReset();
      resolveBundledInstallPlanForCatalogEntry.mockReset();
    }));

  it("enables bundled plugins without adding their bundled directory as a local install", () =>
    withTestDir({ prefix: "openclaw-onboarding-install-bundled-record-" }, async (temp) => {
      const realBundledDir = await bundledDirectory(temp, "discord");
      resolveBundledInstallPlanForCatalogEntry.mockReturnValueOnce({
        bundledSource: { localPath: realBundledDir },
      });
      enablePluginInConfig.mockReturnValueOnce({
        config: { plugins: { entries: { discord: { enabled: true } } } },
        enabled: true,
        pluginId: "discord",
      });

      const result = await runInstall(
        installEntry({ npmSpec: "@openclaw/discord" }, { pluginId: "discord", label: "Discord" }),
        choose("local"),
        { promptInstall: false },
      );

      expect(result.installed).toBe(true);
      expect(result.cfg.plugins?.entries?.discord?.enabled).toBe(true);
      expect(result.cfg.plugins?.load?.paths).toBeUndefined();
      expect(result.cfg.plugins?.installs).toBeUndefined();
      expect(recordPluginInstall).not.toHaveBeenCalled();
    }));
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
