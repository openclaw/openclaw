// One installation-bound trust decision shared by manifest and channel catalog discovery.
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { redactSensitiveText } from "../logging/redact.js";
import { resolveUserPath } from "../utils.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { isTrustedOfficialPluginInstallRecord } from "./official-external-install-records.js";
import { isPathInside } from "./path-safety.js";
import { pluginCacheRealpathSync } from "./plugin-cache-files.js";
import type { PluginTrust } from "./plugin-trust.js";

function resolveCandidateInstallOwner(params: {
  pluginId: string;
  candidate: PluginCandidate;
  installRecords: Record<string, PluginInstallRecord>;
}): string | undefined {
  if (isPluginCandidateInstallOwnerAmbiguous(params.candidate)) {
    return undefined;
  }
  const installOwner = resolvePluginCandidateInstallOwner(params.candidate);
  if (installOwner) {
    return Object.hasOwn(params.installRecords, installOwner) ? installOwner : undefined;
  }
  return undefined;
}

export function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
  installPathOnly?: boolean;
}): boolean {
  if (params.candidate.origin !== "global" && params.candidate.origin !== "config") {
    return false;
  }
  const installOwner = resolveCandidateInstallOwner(params);
  const record = installOwner ? params.installRecords[installOwner] : undefined;
  if (!record) {
    return false;
  }
  const candidatePaths = [
    params.candidate.rootDir,
    params.candidate.packageDir,
    params.candidate.source,
    params.candidate.setupSource,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return pluginCacheRealpathSync(resolved) ?? resolved;
    });
  // Security decisions must bind to the current install output. sourcePath can
  // legitimately identify path installs, but it can also survive a source switch.
  const trackedPaths = (
    params.installPathOnly ? [record.installPath] : [record.installPath, record.sourcePath]
  )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return pluginCacheRealpathSync(resolved) ?? resolved;
    });
  if (candidatePaths.length === 0 || trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some((trackedPath) =>
    candidatePaths.some(
      (candidatePath) =>
        candidatePath === trackedPath ||
        isPathInside(trackedPath, candidatePath) ||
        isPathInside(candidatePath, trackedPath),
    ),
  );
}

export function resolvePluginTrust(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
  registryPath: string;
}): PluginTrust {
  const installOwner = resolveCandidateInstallOwner(params);
  const record = installOwner ? params.installRecords[installOwner] : undefined;
  const origin = params.candidate.origin;
  let reason: PluginTrust["reason"];
  if (origin === "bundled") {
    reason = "bundled";
  } else if (isPluginCandidateInstallOwnerAmbiguous(params.candidate)) {
    reason = "owner-ambiguous";
  } else if (
    origin === "workspace" ||
    record?.source === "path" ||
    (record?.source === "npm" &&
      (record.artifactKind !== undefined || record.sourcePath !== undefined))
  ) {
    reason = "origin-path";
  } else if (!record || !installOwner) {
    reason = "record-missing";
  } else if (
    !matchesInstalledPluginRecord({
      pluginId: params.pluginId,
      candidate: params.candidate,
      env: params.env,
      installRecords: params.installRecords,
      installPathOnly: true,
    })
  ) {
    reason = "install-path-mismatch";
  } else if (
    isTrustedOfficialPluginInstallRecord({
      pluginId: installOwner,
      packageName: params.candidate.packageName,
      record,
    })
  ) {
    reason = "trusted-official";
  } else if (
    (record.source === "npm" &&
      record.spec === undefined &&
      record.resolvedName === undefined &&
      record.resolvedSpec === undefined) ||
    (record.source === "clawhub" &&
      record.clawhubUrl === undefined &&
      record.clawhubChannel === undefined)
  ) {
    reason = "provenance-missing";
  } else {
    reason = "provenance-invalid";
  }
  return {
    reason,
    registryPath: params.registryPath,
    origin,
    installSource: record?.source,
    installSpec:
      record?.spec === undefined ? undefined : redactSensitiveText(record.spec, { mode: "tools" }),
  };
}
