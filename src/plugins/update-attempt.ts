import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import type { NpmIntegrityDriftPayload } from "../infra/npm-integrity.js";
import { isPackageVersionDowngrade } from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { CLAWHUB_INSTALL_ERROR_CODE, isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { installPluginFromGitSpec } from "./git-install.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallArtifactConsentHandler,
} from "./install-types.js";
import { installPluginFromNpmSpec } from "./install.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  formatBetaChannelFallbackOutcomeSuffix,
  resolveExactNpmSpecVersion,
  resolveNewerExactPinnedClawHubDefaultLine,
  resolveNewerExactPinnedNpmDefaultLine,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateLogger,
  type PluginUpdateOutcome,
  type UpdatablePluginInstallRecord,
} from "./update-source.js";

export function formatNewerExactPinnedNpmDefaultLineMessage(params: {
  pluginId: string;
  recordedSpec: string;
  currentVersion: string;
  newer: { packageName: string; registryLine: "beta" | "latest"; version: string };
}): string {
  return (
    `${params.pluginId} is pinned to ${params.recordedSpec} (installed ${params.currentVersion}); ` +
    `registry ${params.newer.registryLine} resolves to ${params.newer.version}. ` +
    `Pass \`openclaw plugins update ${params.newer.packageName}@${params.newer.registryLine}\` to replace this version pin.`
  );
}

function formatNewerExactPinnedClawHubDefaultLineMessage(params: {
  pluginId: string;
  recordedSpec: string;
  currentVersion: string;
  newer: { packageName: string; registryLine: "beta" | "latest"; version: string };
}): string {
  const selector = params.newer.registryLine === "beta" ? "@beta" : "";
  return (
    `${params.pluginId} is pinned to ${params.recordedSpec} (installed ${params.currentVersion}); ` +
    `ClawHub ${params.newer.registryLine} resolves to ${params.newer.version}. ` +
    `Pass \`openclaw plugins install clawhub:${params.newer.packageName}${selector} --force\` to replace this version pin.`
  );
}

export function formatNpmInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  result: { error: string; code?: string };
}): string {
  if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
  }
  return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}

export function formatClawHubInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (ClawHub ${params.spec}).`;
}

export function readClawHubTrustErrorCode(result: {
  code?: string;
}): ClawHubTrustErrorCode | undefined {
  if (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE
  ) {
    return result.code;
  }
  return undefined;
}

export function shouldSkipClawHubTrustFailureForExistingInstall(params: {
  result: { ok: false; code?: string; version?: string };
  currentVersion: string | undefined;
}): boolean {
  if (params.result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE) {
    return Boolean(params.currentVersion);
  }
  if (params.result.code !== CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED) {
    return false;
  }
  return Boolean(
    params.result.version &&
    params.currentVersion &&
    params.result.version !== params.currentVersion,
  );
}

export function buildClawHubTrustSkippedOutcome(params: {
  pluginId: string;
  phase: "check" | "update";
  error: string;
  code: ClawHubTrustErrorCode;
  warning?: string;
  currentVersion?: string;
}): PluginUpdateOutcome {
  return {
    pluginId: params.pluginId,
    status: "skipped",
    ...(params.code ? { code: params.code } : {}),
    ...(params.currentVersion ? { currentVersion: params.currentVersion } : {}),
    ...(params.warning ? { warning: params.warning } : {}),
    message: `Skipped ${params.pluginId} ClawHub ${params.phase}: ${params.error} Existing installed plugin left unchanged.`,
  };
}

export function isClawHubTrustSkippedOutcome(outcome: { status: string; code?: string }): boolean {
  return (
    outcome.status === "skipped" &&
    (outcome.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
      outcome.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE)
  );
}

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: NpmIntegrityDriftPayload) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      pluginId: params.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return false;
  };
}

type PluginUpdateSpecPlan = {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
};

type PluginUpdateInstallResult =
  | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
  | Awaited<ReturnType<typeof installPluginFromClawHub>>
  | Awaited<ReturnType<typeof installPluginFromGitSpec>>
  | Awaited<ReturnType<typeof installPluginFromMarketplace>>;

export type NpmPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromNpmSpec>>,
  { ok: true }
>;
export type ClawHubPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromClawHub>>,
  { ok: true }
>;
export type GitPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromGitSpec>>,
  { ok: true }
>;
export type MarketplacePluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromMarketplace>>,
  { ok: true }
>;
type PluginUpdateSuccess = Extract<PluginUpdateInstallResult, { ok: true }>;

type PluginUpdateAttemptState = {
  activeClawHubInstallSpec?: string;
  channelFallbackSuffix: string;
};

type PluginUpdateAttemptResult =
  | { kind: "exception"; message: string; error: unknown }
  | ({ kind: "result"; result: PluginUpdateInstallResult } & PluginUpdateAttemptState);

function isPluginUpdateUnchanged(
  params: Parameters<typeof buildPluginUpdateVersionOutcome>[0],
): boolean {
  const { record, result, currentVersion, nextVersion } = params;
  const nextCommit = record.source === "git" && "git" in result ? result.git.commit : undefined;
  return record.gitCommit && nextCommit
    ? record.gitCommit === nextCommit
    : Boolean(currentVersion && nextVersion && currentVersion === nextVersion);
}

export async function buildPluginUpdateVersionOutcome(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  result: PluginUpdateSuccess;
  currentVersion?: string;
  nextVersion?: string;
  channelFallbackSuffix: string;
  checkNewerExactPinnedClawHubDefaultLine?: boolean;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
}): Promise<PluginUpdateOutcome> {
  const currentLabel = params.currentVersion ?? "unknown";
  const unchanged = isPluginUpdateUnchanged(params);
  const newerExactPinnedClawHubDefaultLine =
    unchanged &&
    params.record.source === "clawhub" &&
    params.checkNewerExactPinnedClawHubDefaultLine
      ? await resolveNewerExactPinnedClawHubDefaultLine({
          currentVersion: params.currentVersion,
          recordedSpec: params.record.spec,
          probeClawHubVersion: params.nextVersion,
          baseUrl: params.record.clawhubUrl,
          updateChannel: params.updateChannel,
          timeoutMs: params.timeoutMs,
        })
      : undefined;
  const verb = isPackageVersionDowngrade(params.currentVersion, params.nextVersion)
    ? "Downgraded"
    : "Updated";
  return {
    pluginId: params.pluginId,
    status: unchanged ? "unchanged" : "updated",
    currentVersion: params.currentVersion,
    nextVersion: newerExactPinnedClawHubDefaultLine?.version ?? params.nextVersion,
    message: unchanged
      ? newerExactPinnedClawHubDefaultLine && params.record.spec
        ? formatNewerExactPinnedClawHubDefaultLineMessage({
            pluginId: params.pluginId,
            recordedSpec: params.record.spec,
            currentVersion: currentLabel,
            newer: newerExactPinnedClawHubDefaultLine,
          }) + params.channelFallbackSuffix
        : `${params.pluginId} already at ${currentLabel}.${params.channelFallbackSuffix}`
      : `${verb} ${params.pluginId}: ${currentLabel} -> ${params.nextVersion ?? "unknown"}.${params.channelFallbackSuffix}`,
  };
}

export async function buildDryRunPluginUpdateOutcome(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  result: PluginUpdateSuccess;
  currentVersion?: string;
  effectiveSpec?: string;
  hasSpecOverride: boolean;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
  channelFallbackSuffix: string;
  checkNewerExactPinnedClawHubDefaultLine?: boolean;
}): Promise<PluginUpdateOutcome> {
  const npmProbeVersion =
    params.record.source === "npm" ? params.result.npmResolution?.version : undefined;
  const resolvedProbeVersion =
    params.result.version ??
    npmProbeVersion ??
    (params.record.source === "npm" ? resolveExactNpmSpecVersion(params.effectiveSpec) : undefined);
  const nextVersion = resolvedProbeVersion ?? "unknown";
  const currentLabel = params.currentVersion ?? "unknown";
  const unchanged = isPluginUpdateUnchanged({ ...params, nextVersion: resolvedProbeVersion });
  const newerExactPinnedDefaultLine =
    unchanged && params.record.source === "npm" && !params.hasSpecOverride
      ? await resolveNewerExactPinnedNpmDefaultLine({
          currentVersion: params.currentVersion,
          recordedSpec: params.record.spec,
          probeNpmVersion: npmProbeVersion,
          updateChannel: params.updateChannel,
          timeoutMs: params.timeoutMs,
        })
      : undefined;
  const newerExactPinnedClawHubDefaultLine =
    unchanged &&
    params.record.source === "clawhub" &&
    params.checkNewerExactPinnedClawHubDefaultLine
      ? await resolveNewerExactPinnedClawHubDefaultLine({
          currentVersion: params.currentVersion,
          recordedSpec: params.record.spec,
          probeClawHubVersion: resolvedProbeVersion,
          baseUrl: params.record.clawhubUrl,
          updateChannel: params.updateChannel,
          timeoutMs: params.timeoutMs,
        })
      : undefined;

  if (unchanged) {
    const message =
      newerExactPinnedDefaultLine && params.record.spec
        ? formatNewerExactPinnedNpmDefaultLineMessage({
            pluginId: params.pluginId,
            recordedSpec: params.record.spec,
            currentVersion: currentLabel,
            newer: newerExactPinnedDefaultLine,
          }) + params.channelFallbackSuffix
        : newerExactPinnedClawHubDefaultLine && params.record.spec
          ? formatNewerExactPinnedClawHubDefaultLineMessage({
              pluginId: params.pluginId,
              recordedSpec: params.record.spec,
              currentVersion: currentLabel,
              newer: newerExactPinnedClawHubDefaultLine,
            }) + params.channelFallbackSuffix
          : `${params.pluginId} is up to date (${currentLabel}).${params.channelFallbackSuffix}`;
    return {
      pluginId: params.pluginId,
      status: "unchanged",
      currentVersion: params.currentVersion,
      nextVersion:
        newerExactPinnedDefaultLine?.version ??
        newerExactPinnedClawHubDefaultLine?.version ??
        resolvedProbeVersion,
      message,
    };
  }

  const verb = isPackageVersionDowngrade(params.currentVersion, resolvedProbeVersion)
    ? "Would downgrade"
    : "Would update";
  return {
    pluginId: params.pluginId,
    status: "updated",
    currentVersion: params.currentVersion,
    nextVersion: resolvedProbeVersion,
    message: `${verb} ${params.pluginId}: ${currentLabel} -> ${nextVersion}.${params.channelFallbackSuffix}`,
  };
}

export async function runPluginUpdateAttempt(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  config: OpenClawConfig;
  dryRun: boolean;
  effectiveSpec?: string;
  npmMetadata?: Parameters<typeof installPluginFromNpmSpec>[0]["npmMetadata"];
  extensionsDir?: string;
  timeoutMs?: number;
  workTimeoutMs?: number | null;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  expectedIntegrity?: string;
  clawhubSpecs?: PluginUpdateSpecPlan;
  trustedSourceLinkedOfficialInstall: boolean;
  expectedReplacementPluginId?: string;
  onNpmInstall: () => void;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateAttemptResult> {
  const dryRunOption = params.dryRun ? { dryRun: true } : {};
  const phase = params.dryRun ? "check" : "update";
  const commonInstallOptions = copyPluginInstallTransactionRequest(params, {
    config: params.config,
    mode: "update" as const,
    extensionsDir: params.extensionsDir,
    timeoutMs: params.timeoutMs,
    workTimeoutMs: params.workTimeoutMs,
    ...dryRunOption,
    onInstallPolicyWarning: params.onInstallPolicyWarning,
    onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
    expectedPluginId: params.pluginId,
    logger: params.logger,
  });
  let result: PluginUpdateInstallResult;
  try {
    if (params.record.source === "npm" && !params.dryRun) {
      params.onNpmInstall();
    }
    result =
      params.record.source === "npm"
        ? await installPluginFromNpmSpec({
            spec: params.effectiveSpec!,
            npmMetadata: params.npmMetadata,
            ...commonInstallOptions,
            trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
            expectedReplacementPluginId: params.expectedReplacementPluginId,
            expectedIntegrity: params.expectedIntegrity,
            onIntegrityDrift: createPluginUpdateIntegrityDriftHandler(params),
          })
        : params.record.source === "clawhub"
          ? await installPluginFromClawHub({
              spec: params.effectiveSpec ?? `clawhub:${params.record.clawhubPackage!}`,
              baseUrl: params.record.clawhubUrl,
              ...commonInstallOptions,
            })
          : params.record.source === "git"
            ? await installPluginFromGitSpec({
                spec: params.effectiveSpec!,
                ...commonInstallOptions,
              })
            : await installPluginFromMarketplace({
                marketplace: params.record.marketplaceSource!,
                plugin: params.record.marketplacePlugin!,
                ...commonInstallOptions,
              });
  } catch (error) {
    return {
      kind: "exception",
      message: `Failed to ${phase} ${params.pluginId}: ${String(error)}`,
      error,
    };
  }

  let activeClawHubInstallSpec = params.effectiveSpec;
  let channelFallbackSuffix = "";

  if (
    !result.ok &&
    params.record.source === "clawhub" &&
    params.clawhubSpecs?.fallbackSpec &&
    isUnavailableClawHubTarget(result)
  ) {
    channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
      fallbackLabel: params.clawhubSpecs.fallbackLabel ?? params.effectiveSpec,
      fallbackSpec: params.clawhubSpecs.fallbackSpec,
      verb: params.dryRun ? "would use" : "used",
    });
    params.logger.info?.(
      `Plugin "${params.pluginId}" has no beta ClawHub release for ${params.clawhubSpecs.fallbackLabel ?? params.effectiveSpec}; using ${params.clawhubSpecs.fallbackSpec} instead. Core update can still complete.`,
    );
    result = await installPluginFromClawHub({
      spec: params.clawhubSpecs.fallbackSpec,
      baseUrl: params.record.clawhubUrl,
      ...commonInstallOptions,
    });
    activeClawHubInstallSpec = params.clawhubSpecs.fallbackSpec;
  }

  return {
    kind: "result",
    result,
    activeClawHubInstallSpec,
    channelFallbackSuffix,
  };
}
