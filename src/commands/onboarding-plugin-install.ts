import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config-write-guard.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
} from "../plugins/bundled-sources.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "../plugins/capability-consent.js";
import { isUnavailableClawHubTarget } from "../plugins/clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "../plugins/clawhub-install-records.js";
import { enableExplicitlySelectedPluginInConfig } from "../plugins/enable.js";
import {
  installWithSourceFallback,
  NpmChannelResolutionError,
  resolvePluginInstallSources,
  isUnavailablePluginSource,
  installWithChannelFallback,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../plugins/install-channel-specs.js";
import {
  type PluginInstallOverride,
  resolvePluginInstallOverride,
  PLUGIN_INSTALL_OVERRIDES_ENV,
  ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV,
} from "../plugins/install-overrides.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { resolveBundledInstallPlanForCatalogEntry } from "../plugins/install-source-plan.js";
import { isUnavailableNpmTarget } from "../plugins/install-types.js";
import {
  installPluginFromNpmSpec,
  installPluginFromNpmPackArchive,
  type InstallPluginResult,
} from "../plugins/install.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../plugins/installs.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { invalidatePluginRuntimeDiscoveryAfterConfigMutation } from "../plugins/registry-refresh.js";
import type { RuntimeEnv } from "../runtime.js";
import { withTimeout } from "../utils/with-timeout.js";
import { VERSION } from "../version.js";
import { t } from "../wizard/i18n/index.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import {
  WizardCancelledError,
  WizardNavigationError,
  type WizardPrompter,
} from "../wizard/prompts.js";

type InstallChoice = "clawhub" | "npm" | "local" | "skip";
type InstallPluginFromClawHubResult = Awaited<
  ReturnType<(typeof import("../plugins/clawhub.js"))["installPluginFromClawHub"]>
>;
type ArtifactConsent = Awaited<ReturnType<typeof prepareManagedPluginArtifactConsentHandler>>;
type InstallOutcome<T> =
  | { status: "timed_out" }
  | { status: "completed"; result: T; capabilityConsent: ArtifactConsent };
const ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS = ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS + 5_000;

/** Catalog entry used by onboarding to offer or require a plugin install. */
export type OnboardingPluginInstallEntry = {
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  trustedSourceLinkedOfficialInstall?: boolean;
  /** Keep this official runtime package on the same release cohort as OpenClaw. */
  versionBoundToOpenClaw?: boolean;
};

/** Outcome status for a single onboarding plugin install attempt. */
export type OnboardingPluginInstallStatus = "installed" | "skipped" | "failed" | "timed_out";

/** Config and status returned after attempting an onboarding plugin install. */
type OnboardingPluginInstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId: string;
  status: OnboardingPluginInstallStatus;
  /** Sanitized actionable detail for non-interactive callers. */
  error?: string;
};

type OnboardingPluginInstallParams = {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  onCapabilityConsent: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
};

function incompletePluginInstall(
  cfg: OpenClawConfig,
  pluginId: string,
  status: Exclude<OnboardingPluginInstallStatus, "installed">,
  error?: string,
): OnboardingPluginInstallResult {
  return { cfg, installed: false, pluginId, status, ...(error === undefined ? {} : { error }) };
}

function resolveRealDirectory(dir: string): string | null {
  try {
    const resolved = fs.realpathSync(dir);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function resolveGitDirectoryMarker(dir: string): string | null {
  const marker = path.join(dir, ".git");
  try {
    const stat = fs.statSync(marker);
    if (stat.isDirectory()) {
      return resolveRealDirectory(marker);
    }
    if (!stat.isFile()) {
      return null;
    }
    const content = fs.readFileSync(marker, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(content);
    if (!match) {
      return null;
    }
    const gitDir = match[1]?.trim();
    if (!gitDir) {
      return null;
    }
    return resolveRealDirectory(path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir));
  } catch {
    return null;
  }
}

function hasTrustedGitWorkspace(root: string): boolean {
  const realRoot = resolveRealDirectory(root);
  if (!realRoot) {
    return false;
  }
  for (let dir = realRoot; ; dir = path.dirname(dir)) {
    if (resolveGitDirectoryMarker(dir)) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }
  }
}

function hasGitWorkspace(workspaceDir?: string): boolean {
  const roots = [process.cwd()];
  if (workspaceDir && workspaceDir !== process.cwd()) {
    roots.push(workspaceDir);
  }
  return roots.some((root) => hasTrustedGitWorkspace(root));
}

function addPluginLoadPath(cfg: OpenClawConfig, pluginPath: string): OpenClawConfig {
  const existing = cfg.plugins?.load?.paths ?? [];
  const merged = uniqueStrings([...existing, pluginPath]);
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      load: {
        ...cfg.plugins?.load,
        paths: merged,
      },
    },
  };
}

function pathsReferToSameDirectory(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  const realLeft = resolveRealDirectory(left);
  const realRight = resolveRealDirectory(right);
  return Boolean(realLeft && realRight && realLeft === realRight);
}

function formatPortableLocalPath(localPath: string, workspaceDir?: string): string | undefined {
  const bases = [workspaceDir, process.cwd()].filter((entry): entry is string => Boolean(entry));
  for (const base of bases) {
    const realBase = resolveRealDirectory(base);
    if (!realBase) {
      continue;
    }
    if (isPathInside(realBase, localPath)) {
      const relative = path.relative(realBase, localPath);
      const portable = relative.split(path.sep).join("/");
      return portable ? `./${portable}` : ".";
    }
  }
  return undefined;
}

function resolveLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
  allowLocal: boolean;
}): string | null {
  if (!params.allowLocal) {
    return null;
  }
  const raw = params.entry.install.localPath?.trim();
  if (!raw) {
    return null;
  }
  const candidates = new Set<string>();
  const bases = [process.cwd()];
  if (params.workspaceDir && params.workspaceDir !== process.cwd()) {
    bases.push(params.workspaceDir);
  }
  for (const base of bases) {
    const realBase = resolveRealDirectory(base);
    if (!realBase) {
      continue;
    }
    candidates.add(path.resolve(realBase, raw));
  }
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      // Local plugin paths must stay inside the current repo/workspace roots so
      // catalog metadata cannot point setup at arbitrary filesystem locations.
      if (
        !bases.some((base) => {
          const realBase = resolveRealDirectory(base);
          return realBase ? isPathInside(realBase, resolved) : false;
        })
      ) {
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBundledLocalPath(params: {
  entry: OnboardingPluginInstallEntry;
  workspaceDir?: string;
}): string | null {
  const bundledSources = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  const npmSpec = params.entry.install.npmSpec?.trim();
  if (npmSpec) {
    return (
      resolveBundledInstallPlanForCatalogEntry({
        pluginId: params.entry.pluginId,
        npmSpec,
        findBundledSource: (lookup) =>
          findBundledPluginSourceInMap({
            bundled: bundledSources,
            lookup,
          }),
      })?.bundledSource.localPath ?? null
    );
  }
  return (
    findBundledPluginSourceInMap({
      bundled: bundledSources,
      lookup: {
        kind: "pluginId",
        value: params.entry.pluginId,
      },
    })?.localPath ?? null
  );
}

function resolveInstallDefaultChoice(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  localPath?: string | null;
  bundledLocalPath?: string | null;
  hasClawHubSpec: boolean;
  hasNpmSpec: boolean;
}): InstallChoice {
  const { cfg, entry, localPath, bundledLocalPath, hasClawHubSpec, hasNpmSpec } = params;
  const hasRemoteSpec = hasClawHubSpec || hasNpmSpec;
  const entryDefault = entry.install.defaultChoice;
  const remoteDefault = (): InstallChoice =>
    resolvePluginInstallSources(entry.install)[0]?.source ?? "skip";

  if (!hasRemoteSpec) {
    return localPath ? "local" : "skip";
  }
  if (!localPath) {
    return remoteDefault();
  }
  if (bundledLocalPath) {
    return "local";
  }
  const updateChannel = cfg.update?.channel;
  // Dev builds prefer checked-out local plugins; stable/beta prefer published
  // artifacts so installed records match the user's release channel.
  if (updateChannel === "dev") {
    return "local";
  }
  if (
    updateChannel === "stable" ||
    updateChannel === "extended-stable" ||
    updateChannel === "beta"
  ) {
    return remoteDefault();
  }
  if (entryDefault === "local") {
    return "local";
  }
  return remoteDefault();
}

async function promptInstallChoice(params: {
  label: string;
  localPath?: string | null;
  defaultChoice: InstallChoice;
  prompter: WizardPrompter;
  /** Skip the redundant prompt when the caller already chose the only viable source. */
  autoConfirmSingleSource?: boolean;
  npmSpec: string | null;
  clawhubSpec: string | null;
}): Promise<InstallChoice> {
  const { npmSpec, clawhubSpec } = params;
  const safeLabel = sanitizeTerminalText(params.label);
  const safeClawHubSpec = clawhubSpec ? sanitizeTerminalText(clawhubSpec) : null;
  const safeNpmSpec = npmSpec ? sanitizeTerminalText(npmSpec) : null;
  const safeLocalPath = params.localPath ? sanitizeTerminalText(params.localPath) : null;
  const options: Array<{ value: InstallChoice; label: string; hint?: string }> = [];
  if (safeNpmSpec) {
    options.push({
      value: "npm",
      label: t("wizard.plugins.downloadFromNpm", { spec: safeNpmSpec }),
    });
  }
  if (safeClawHubSpec) {
    options.push({
      value: "clawhub",
      label: t("wizard.plugins.downloadFromClawHub", { spec: safeClawHubSpec }),
    });
  }
  if (params.localPath) {
    options.push({
      value: "local",
      label: t("wizard.plugins.useLocalPluginPath"),
      ...(safeLocalPath ? { hint: safeLocalPath } : {}),
    });
  }

  if (params.autoConfirmSingleSource && options.length === 1) {
    return options[0]!.value;
  }

  options.push({ value: "skip", label: t("common.skipForNow") });

  const initialValue = ([params.defaultChoice, "clawhub", "npm", "local", "skip"] as const).find(
    (choice) => options.some((option) => option.value === choice),
  );

  return await params.prompter.select<InstallChoice>({
    message: t("wizard.plugins.installPluginPrompt", { plugin: safeLabel }),
    options,
    initialValue,
  });
}

function formatPluginInstallTimedOutNote(spec: string): string {
  return [
    t("wizard.plugins.installTimedOut", {
      spec,
      duration: t("common.minutes", { count: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS / 60_000 }),
    }),
    t("wizard.plugins.returningToSelection"),
  ].join("\n");
}

function summarizeInstallError(message: string): string {
  const cleaned = sanitizeTerminalText(message)
    .replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "")
    .trim();
  if (!cleaned) {
    return "Unknown install failure";
  }
  return cleaned.length > 180 ? `${truncateUtf16Safe(cleaned, 179)}…` : cleaned;
}

const ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS = 12_000;

function formatInstallErrorDetail(message: string): string {
  const cleaned = message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n")
    .trim();
  if (cleaned.length <= ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS) {
    return cleaned;
  }
  const marker = "\n… (installer output truncated)";
  return `${truncateUtf16Safe(cleaned, ONBOARDING_PLUGIN_INSTALL_ERROR_MAX_CHARS - marker.length).trimEnd()}${marker}`;
}

async function notePluginInstallFailure(
  prompter: WizardPrompter,
  spec: string,
  error: string,
): Promise<void> {
  await prompter.note(
    [
      t("wizard.plugins.installFailed", {
        spec: sanitizeTerminalText(spec),
        error: summarizeInstallError(error),
      }),
      t("wizard.plugins.returningToSelection"),
    ].join("\n"),
    t("wizard.plugins.installTitle"),
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout";
}

async function finishOnboardingPluginInstall(params: {
  cfg: OpenClawConfig;
  pluginId: string;
  label: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  install?: Parameters<typeof recordPluginInstall>[1];
  prepareConfig?: (cfg: OpenClawConfig) => OpenClawConfig | Promise<OpenClawConfig>;
}): Promise<OnboardingPluginInstallResult> {
  const enableResult = enableExplicitlySelectedPluginInConfig(params.cfg, params.pluginId);
  if (!enableResult.enabled) {
    const safeLabel = sanitizeTerminalText(params.label);
    const reason = enableResult.reason ?? "plugin disabled";
    await params.prompter.note(
      t("wizard.plugins.enableFailed", { plugin: safeLabel, reason }),
      t("wizard.plugins.installTitle"),
    );
    params.runtime.error?.(
      `Plugin install failed: ${sanitizeTerminalText(params.pluginId)} is disabled (${reason}).`,
    );
    return incompletePluginInstall(enableResult.config, params.pluginId, "failed");
  }
  const cfg = params.install
    ? recordPluginInstall(enableResult.config, params.install)
    : ((await params.prepareConfig?.(enableResult.config)) ?? enableResult.config);
  // Onboarding has not committed config yet, so invalidate only process-local
  // discovery. The next lookup recovers the new package alongside persisted records.
  clearLoadInstalledPluginIndexInstallRecordsCache();
  clearPluginMetadataLifecycleCaches();
  await invalidatePluginRuntimeDiscoveryAfterConfigMutation({
    logger: { warn: (message) => params.runtime.log(message) },
  });
  return { cfg, installed: true, pluginId: params.pluginId, status: "installed" };
}

async function installLocalOnboardingPlugin(
  params: OnboardingPluginInstallParams & {
    localPath: string;
    bundledLocalPath: string | null;
    npmSpec: string | null;
    workspaceDir?: string;
  },
): Promise<OnboardingPluginInstallResult> {
  const consent = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  try {
    return await finishOnboardingPluginInstall({
      cfg: params.cfg,
      pluginId: params.entry.pluginId,
      label: params.entry.label,
      prompter: params.prompter,
      runtime: params.runtime,
      prepareConfig: async (cfg) => {
        // Bundled sources already belong to the release; linked artifacts still require review.
        if (pathsReferToSameDirectory(params.localPath, params.bundledLocalPath)) {
          return cfg;
        }
        const capabilityConsent = await prepareManagedPluginArtifactConsentHandler({
          config: params.cfg,
          source: "path",
          spec: params.npmSpec ?? params.localPath,
          onCapabilityConsent: consent.onCapabilityConsent,
          beforePersistentEffect: params.beforePersistentEffect,
        });
        await capabilityConsent.onBeforePluginArtifactCommit({
          pluginId: params.entry.pluginId,
          stagedArtifactDir: params.localPath,
          mode: "install",
        });
        const sourcePath = formatPortableLocalPath(params.localPath, params.workspaceDir);
        return recordPluginInstall(
          addPluginLoadPath(cfg, params.localPath),
          capabilityConsent.applyAcceptedSurface(params.entry.pluginId, {
            pluginId: params.entry.pluginId,
            source: "path",
            installPath: params.localPath,
            ...(sourcePath ? { sourcePath } : {}),
            ...(params.npmSpec ? { spec: params.npmSpec } : {}),
          }),
        );
      },
    });
  } catch (error) {
    consent.rethrowCallbackError();
    const detail = error instanceof Error ? error.message : String(error);
    await notePluginInstallFailure(params.prompter, params.localPath, detail);
    return incompletePluginInstall(
      params.cfg,
      params.entry.pluginId,
      "failed",
      formatInstallErrorDetail(detail),
    );
  }
}

function logInstallWarningWithSpacing(runtime: RuntimeEnv, message: string): void {
  const sanitized = sanitizeTerminalText(message).trim();
  if (!sanitized) {
    return;
  }
  runtime.log?.(`${sanitized}\n`);
}

function logInstallWarningWithLineBreaks(runtime: RuntimeEnv, message: string): void {
  const sanitized = message
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n")
    .trim();
  if (!sanitized) {
    return;
  }
  runtime.log?.(`${sanitized}\n`);
}

function startPluginInstallProgress(prompter: WizardPrompter, safeLabel: string) {
  const progress = prompter.progress(t("wizard.plugins.installingPlugin", { plugin: safeLabel }));
  progress.update(t("wizard.plugins.preparingInstall"));
  return {
    progress,
    updateProgress: (message: string) => {
      const sanitized = sanitizeTerminalText(message).trim();
      if (sanitized) {
        progress.update(sanitized);
      }
    },
  };
}

async function runInstallWatchdog<T>(install: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const ownedInstallPromise = install(controller.signal);
  try {
    return await withTimeout(ownedInstallPromise, ONBOARDING_PLUGIN_INSTALL_WATCHDOG_TIMEOUT_MS);
  } catch (error) {
    if (isTimeoutError(error)) {
      // Cancel owned child processes, then retain the lifecycle lease through rollback.
      controller.abort();
      await ownedInstallPromise.catch(() => undefined);
    }
    throw error;
  }
}

async function installPluginFromNpmWithProgress(
  params: OnboardingPluginInstallParams & {
    source: PluginInstallOverride;
    trustedSourceLinkedOfficialInstall?: boolean;
  },
): Promise<InstallOutcome<InstallPluginResult & { npmTarballName?: string }>> {
  const { source } = params;
  const consent = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  const capabilityConsent = await prepareManagedPluginArtifactConsentHandler({
    config: params.cfg,
    source: "npm",
    spec: source.kind === "npm" ? source.spec : `npm-pack:${source.archivePath}`,
    expectedIntegrity: params.entry.install.expectedIntegrity,
    onCapabilityConsent: consent.onCapabilityConsent,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const { progress, updateProgress } = startPluginInstallProgress(params.prompter, safeLabel);

  try {
    const result = await runInstallWatchdog((signal) => {
      const options = {
        config: params.cfg,
        timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
        expectedPluginId: params.entry.pluginId,
        expectedIntegrity: params.entry.install.expectedIntegrity,
        extensionsDir: resolveDefaultPluginExtensionsDir(),
        logger: {
          info: updateProgress,
          warn: (message: string) => {
            updateProgress(message);
            logInstallWarningWithSpacing(params.runtime, message);
          },
        },
        signal,
        onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
      };
      return source.kind === "npm-pack"
        ? installPluginFromNpmPackArchive({ ...options, archivePath: source.archivePath })
        : installPluginFromNpmSpec({
            ...options,
            spec: source.spec,
            mode: "update",
            ...((params.trustedSourceLinkedOfficialInstall ??
            params.entry.trustedSourceLinkedOfficialInstall)
              ? { trustedSourceLinkedOfficialInstall: true }
              : {}),
          });
    });
    progress.stop(
      t(result.ok ? "wizard.plugins.installedPlugin" : "wizard.plugins.installFailedShort", {
        plugin: safeLabel,
      }),
    );
    consent.rethrowCallbackError();
    return { status: "completed", result, capabilityConsent };
  } catch (error) {
    progress.stop(
      t(
        isTimeoutError(error)
          ? "wizard.plugins.installTimedOutShort"
          : "wizard.plugins.installFailedShort",
        { plugin: safeLabel },
      ),
    );
    consent.rethrowCallbackError();
    if (isTimeoutError(error)) {
      return { status: "timed_out" };
    }
    // Archive overrides retain their existing unexpected-error contract.
    if (source.kind === "npm-pack" && !(error instanceof ManagedPluginLifecycleError)) {
      throw error;
    }
    return {
      status: "completed",
      capabilityConsent,
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function installPluginFromOverride(
  params: OnboardingPluginInstallParams & {
    override: PluginInstallOverride;
  },
): Promise<OnboardingPluginInstallResult> {
  const { entry, prompter, runtime } = params;
  runtime.log?.(
    `Using plugin install override for ${sanitizeTerminalText(entry.pluginId)} from ${PLUGIN_INSTALL_OVERRIDES_ENV} (${ALLOW_PLUGIN_INSTALL_OVERRIDES_ENV}=1).`,
  );
  // Overrides are explicit operator/developer input and intentionally bypass
  // catalog trust defaults while still recording the resulting install source.
  const installOutcome = await installPluginFromNpmWithProgress({
    ...params,
    source: params.override,
    trustedSourceLinkedOfficialInstall: false,
  });

  const displaySpec =
    params.override.kind === "npm"
      ? params.override.spec
      : `npm-pack:${params.override.archivePath}`;
  if (installOutcome.status === "timed_out") {
    await prompter.note(
      formatPluginInstallTimedOutNote(sanitizeTerminalText(displaySpec)),
      t("wizard.plugins.installTitle"),
    );
    runtime.error?.(
      `Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(displaySpec)}`,
    );
    return incompletePluginInstall(params.cfg, entry.pluginId, "timed_out");
  }

  const { result } = installOutcome;
  if (!result.ok) {
    const errorDetail = formatInstallErrorDetail(result.error);
    await notePluginInstallFailure(prompter, displaySpec, result.error);
    runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
    return incompletePluginInstall(params.cfg, entry.pluginId, "failed", errorDetail);
  }

  const npmTarballName = params.override.kind === "npm-pack" ? result.npmTarballName : undefined;
  const install = {
    pluginId: result.pluginId,
    source: "npm" as const,
    spec:
      params.override.kind === "npm-pack"
        ? (result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId)
        : params.override.spec,
    ...(params.override.kind === "npm-pack" ? { sourcePath: params.override.archivePath } : {}),
    installPath: result.targetDir,
    ...(result.version ? { version: result.version } : {}),
    ...buildNpmResolutionInstallFields(result.npmResolution),
    ...(params.override.kind === "npm-pack"
      ? {
          artifactKind: "npm-pack" as const,
          artifactFormat: "tgz" as const,
          ...(result.npmResolution?.integrity
            ? { npmIntegrity: result.npmResolution.integrity }
            : {}),
          ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
          ...(npmTarballName ? { npmTarballName } : {}),
        }
      : {}),
  };
  return await finishOnboardingPluginInstall({
    cfg: params.cfg,
    pluginId: result.pluginId,
    label: entry.label,
    prompter,
    runtime,
    install: installOutcome.capabilityConsent.applyAcceptedSurface(result.pluginId, install),
  });
}

async function installPluginFromClawHubSpecWithProgress(
  params: OnboardingPluginInstallParams & {
    clawhubSpec: string;
  },
): Promise<{ result: InstallPluginFromClawHubResult; capabilityConsent: ArtifactConsent }> {
  const consent = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  const capabilityConsent = await prepareManagedPluginArtifactConsentHandler({
    config: params.cfg,
    source: "clawhub",
    spec: params.clawhubSpec,
    expectedIntegrity: params.entry.install.expectedIntegrity,
    onCapabilityConsent: consent.onCapabilityConsent,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  const safeLabel = sanitizeTerminalText(params.entry.label);
  const { progress, updateProgress } = startPluginInstallProgress(params.prompter, safeLabel);
  let renderedTrustWarning = false;
  const renderTrustWarning = (message: string) => {
    logInstallWarningWithLineBreaks(params.runtime, message);
    renderedTrustWarning = true;
  };

  try {
    const { installPluginFromClawHub } = await import("../plugins/clawhub.js");
    const result = await installPluginFromClawHub({
      spec: params.clawhubSpec,
      expectedIntegrity: params.entry.install.expectedIntegrity,
      timeoutMs: ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS,
      config: params.cfg,
      extensionsDir: resolveDefaultPluginExtensionsDir(),
      expectedPluginId: params.entry.pluginId,
      mode: "install",
      onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
      logger: {
        info: updateProgress,
        warn: (message) => {
          updateProgress(message);
          const plain = stripAnsi(message);
          if (plain.startsWith("Warning\n")) {
            return;
          }
          if (plain.startsWith("Blocked\n") || plain.startsWith("Review\n")) {
            renderTrustWarning(message);
            return;
          }
          logInstallWarningWithSpacing(params.runtime, message);
        },
      },
    });
    const failureWarning = !result.ok && "warning" in result ? result.warning : undefined;
    if (failureWarning && !renderedTrustWarning) {
      progress.stop("Review ClawHub warning");
      renderTrustWarning(failureWarning);
    }
    progress.stop(
      t(result.ok ? "wizard.plugins.installedPlugin" : "wizard.plugins.installFailedShort", {
        plugin: safeLabel,
      }),
    );
    consent.rethrowCallbackError();
    return { result, capabilityConsent };
  } catch (error) {
    progress.stop(t("wizard.plugins.installFailedShort", { plugin: safeLabel }));
    consent.rethrowCallbackError();
    // The separate ClawHub risk prompt also owns wizard navigation.
    if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
      throw error;
    }
    return {
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      capabilityConsent,
    };
  }
}

/** Ensures an onboarding plugin is installed, enabled, and recorded in config. */
export async function ensureOnboardingPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: OnboardingPluginInstallEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
  autoConfirmSingleSource?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<OnboardingPluginInstallResult> {
  const { entry, prompter, runtime, workspaceDir } = params;
  const next = params.cfg;
  const onCapabilityConsent =
    params.onCapabilityConsent ?? createPluginCapabilityConsentPrompter(prompter);
  const installOverride = resolvePluginInstallOverride({ pluginId: entry.pluginId });
  if (installOverride) {
    // Any install override mutates config/install records, so guard it with the
    // same write-mode check as normal installs.
    assertConfigWriteAllowedInCurrentMode();
    return await withPluginLifecycleLease({}, async () =>
      installPluginFromOverride({
        ...params,
        override: installOverride,
        onCapabilityConsent,
      }),
    );
  }
  const allowLocal = hasGitWorkspace(workspaceDir);
  const bundledLocalPath = resolveBundledLocalPath({ entry, workspaceDir });
  const localPath = bundledLocalPath ?? resolveLocalPath({ entry, workspaceDir, allowLocal });
  const rawClawHubSpec = entry.install.clawhubSpec?.trim();
  const clawhubSpec =
    rawClawHubSpec && parseClawHubPluginSpec(rawClawHubSpec) ? rawClawHubSpec : null;
  const rawNpmSpec = entry.install.npmSpec?.trim();
  const npmSpec = rawNpmSpec && parseRegistryNpmSpec(rawNpmSpec) ? rawNpmSpec : null;
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(next.update?.channel),
    currentVersion: VERSION,
  });
  const clawhubSpecs = clawhubSpec
    ? resolveClawHubInstallSpecsForUpdateChannel({
        spec: clawhubSpec,
        updateChannel,
        officialPackageName: entry.trustedSourceLinkedOfficialInstall
          ? parseClawHubPluginSpec(clawhubSpec)?.name
          : undefined,
        coreVersion: VERSION,
        versionBoundToCore: entry.versionBoundToOpenClaw,
      })
    : null;
  let npmSpecs: Awaited<ReturnType<typeof resolveNpmInstallSpecsForUpdateChannel>> | undefined;
  const clawhubInstallSpec = clawhubSpecs?.installSpec ?? clawhubSpec;
  const defaultChoice = resolveInstallDefaultChoice({
    cfg: next,
    entry,
    localPath,
    bundledLocalPath,
    hasClawHubSpec: Boolean(clawhubSpec),
    hasNpmSpec: Boolean(npmSpec),
  });
  const choice =
    params.promptInstall === false
      ? defaultChoice
      : await promptInstallChoice({
          label: entry.label,
          localPath,
          defaultChoice,
          prompter,
          autoConfirmSingleSource: params.autoConfirmSingleSource,
          // Bundled plugins are version-locked; remote specs are fallback metadata only.
          clawhubSpec: bundledLocalPath ? null : clawhubInstallSpec,
          npmSpec: bundledLocalPath ? null : npmSpec,
        });

  if (choice === "skip") {
    return incompletePluginInstall(next, entry.pluginId, "skipped");
  }
  assertConfigWriteAllowedInCurrentMode();

  return await withPluginLifecycleLease({}, async () => {
    const installLocal = (selectedPath: string) =>
      installLocalOnboardingPlugin({
        ...params,
        localPath: selectedPath,
        bundledLocalPath,
        npmSpec,
        onCapabilityConsent,
      });
    if (choice === "local" && localPath) {
      return await installLocal(localPath);
    }

    const sources = resolvePluginInstallSources(
      entry.install,
      params.promptInstall === false
        ? undefined
        : choice === "npm" || choice === "clawhub"
          ? choice
          : undefined,
    );
    if (sources.length === 0) {
      return incompletePluginInstall(
        next,
        entry.pluginId,
        "failed",
        "No declared remote install source.",
      );
    }
    if (npmSpec && sources.some((source) => source.source === "npm")) {
      try {
        npmSpecs = await resolveNpmInstallSpecsForUpdateChannel({
          spec: npmSpec,
          updateChannel,
          officialPackageName: entry.trustedSourceLinkedOfficialInstall
            ? parseRegistryNpmSpec(npmSpec)?.name
            : undefined,
          coreVersion: VERSION,
          versionBoundToCore: entry.versionBoundToOpenClaw,
        });
      } catch (error) {
        if (!(error instanceof NpmChannelResolutionError)) {
          throw error;
        }
        await notePluginInstallFailure(prompter, npmSpec, error.message);
        return incompletePluginInstall(
          next,
          entry.pluginId,
          "failed",
          formatInstallErrorDetail(error.message),
        );
      }
    }
    const { attempt: installOutcome, source: installedSource } = await installWithSourceFallback({
      sources,
      install: async (
        source,
      ): Promise<InstallOutcome<InstallPluginResult | InstallPluginFromClawHubResult>> => {
        const specs = source.source === "npm" ? npmSpecs : clawhubSpecs;
        const attemptEntry = {
          ...entry,
          install: { ...entry.install, expectedIntegrity: source.expectedIntegrity },
        };
        return await installWithChannelFallback({
          installSpec: specs?.installSpec ?? source.spec,
          ...(source.expectedIntegrity ? {} : { fallbackSpec: specs?.fallbackSpec }),
          install: async (
            spec,
          ): Promise<InstallOutcome<InstallPluginResult | InstallPluginFromClawHubResult>> =>
            source.source === "clawhub"
              ? {
                  status: "completed",
                  ...(await installPluginFromClawHubSpecWithProgress({
                    ...params,
                    entry: attemptEntry,
                    clawhubSpec: spec,
                    onCapabilityConsent,
                  })),
                }
              : await installPluginFromNpmWithProgress({
                  ...params,
                  entry: attemptEntry,
                  source: { kind: "npm", spec },
                  onCapabilityConsent,
                }),
          isRetryable: (attempt) =>
            attempt.status === "completed" &&
            !attempt.result.ok &&
            (source.source === "npm"
              ? isUnavailableNpmTarget(attempt.result)
              : isUnavailableClawHubTarget(attempt.result)),
          onFallback: async (message) => {
            await prompter.note(message, t("wizard.plugins.installTitle"));
          },
        });
      },
      result: (attempt) => (attempt.status === "completed" ? attempt.result : { ok: false }),
      onFallback: async (message) => {
        await prompter.note(message, t("wizard.plugins.installTitle"));
      },
    });
    if (installOutcome.status === "timed_out") {
      await prompter.note(
        formatPluginInstallTimedOutNote(sanitizeTerminalText(installedSource.spec)),
        t("wizard.plugins.installTitle"),
      );
      runtime.error?.(
        `Plugin install timed out after ${ONBOARDING_PLUGIN_INSTALL_TIMEOUT_MS}ms: ${sanitizeTerminalText(installedSource.spec)}`,
      );
      return incompletePluginInstall(next, entry.pluginId, "timed_out");
    }
    const { result, capabilityConsent } = installOutcome;
    if (result.ok) {
      const spec =
        (installedSource.source === "npm" ? npmSpecs : clawhubSpecs)?.recordSpec ??
        installedSource.spec;
      const install =
        "clawhub" in result
          ? {
              ...buildClawHubPluginInstallRecordFields(result.clawhub),
              spec,
              installPath: result.targetDir,
            }
          : {
              source: "npm" as const,
              spec,
              installPath: result.targetDir,
              version: result.version,
              ...buildNpmResolutionInstallFields(result.npmResolution),
            };
      return await finishOnboardingPluginInstall({
        cfg: next,
        pluginId: result.pluginId,
        label: entry.label,
        prompter,
        runtime,
        install: capabilityConsent.applyAcceptedSurface(result.pluginId, {
          pluginId: result.pluginId,
          ...install,
        }),
      });
    }
    await notePluginInstallFailure(prompter, installedSource.spec, result.error);
    if (localPath && isUnavailablePluginSource(installedSource.source, result)) {
      const fallback = await prompter.confirm({
        message: t("wizard.plugins.useLocalPluginPathInstead", {
          path: sanitizeTerminalText(localPath),
        }),
        initialValue: true,
      });
      if (fallback) {
        return await installLocal(localPath);
      }
    }
    runtime.error?.(`Plugin install failed: ${summarizeInstallError(result.error)}`);
    return incompletePluginInstall(
      next,
      entry.pluginId,
      "failed",
      formatInstallErrorDetail(result.error),
    );
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
