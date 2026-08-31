import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { createNpmMetadataEnv, resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import {
  isExactSemverVersion,
  isPrereleaseResolutionAllowed,
  isPrereleaseSemverVersion,
  parseRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { comparePackageUpdateVersions } from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { runCommandWithTimeout } from "../process/exec.js";

export function resolveNpmSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseRegistryNpmSpec(spec)?.name : undefined;
}

export function resolveExactNpmSpecVersion(spec: string | undefined): string | undefined {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version"
    ? normalizeExactNpmVersion(parsed.selector)
    : undefined;
}

function normalizeExactNpmVersion(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!isExactSemverVersion(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export async function resolveNewerExactPinnedNpmDefaultLine(params: {
  currentVersion: string | undefined;
  effectiveSpec: string | undefined;
  probeNpmVersion: string | undefined;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ packageName: string; registryLine: "beta" | "latest"; version: string } | undefined> {
  params.signal?.throwIfAborted();
  if (!params.currentVersion || !params.probeNpmVersion || !params.effectiveSpec) {
    return undefined;
  }
  const packageName = resolveNpmSpecPackageName(params.effectiveSpec);
  const exactVersion = resolveExactNpmSpecVersion(params.effectiveSpec);
  const probeNpmVersion = normalizeExactNpmVersion(params.probeNpmVersion);
  if (!packageName || !exactVersion || probeNpmVersion !== exactVersion) {
    return undefined;
  }

  const resolveMetadata = async (spec: string) => {
    try {
      const result = await resolveNpmSpecMetadata({
        spec,
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      params.signal?.throwIfAborted();
      return result;
    } catch {
      params.signal?.throwIfAborted();
      return undefined;
    }
  };
  let registryLine: "beta" | "latest" = params.updateChannel === "beta" ? "beta" : "latest";
  let metadataResult = await resolveMetadata(
    registryLine === "beta" ? `${packageName}@beta` : packageName,
  );
  if (registryLine === "beta" && !metadataResult?.ok) {
    registryLine = "latest";
    metadataResult = await resolveMetadata(packageName);
  }
  if (
    !metadataResult?.ok ||
    metadataResult.metadata.name !== packageName ||
    !metadataResult.metadata.version
  ) {
    return undefined;
  }
  return comparePackageUpdateVersions(metadataResult.metadata.version, params.currentVersion) > 0
    ? { packageName, registryLine, version: metadataResult.metadata.version }
    : undefined;
}

async function loadNpmPackageVersionsForUpdate(params: {
  packageName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string[] | null> {
  params.signal?.throwIfAborted();
  const versions = await runCommandWithTimeout(
    ["npm", "view", params.packageName, "versions", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs ?? 0, 60_000),
      env: createNpmMetadataEnv(),
      ...(params.signal ? { signal: params.signal, killProcessTree: true } : {}),
    },
  );
  params.signal?.throwIfAborted();
  if (!versions || versions.code !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(versions.stdout.trim());
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
}

export async function resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate(params: {
  metadata: NpmSpecResolution;
  spec: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  | {
      kind: "stable" | "prerelease-only";
      metadata: NpmSpecResolution;
    }
  | undefined
> {
  params.signal?.throwIfAborted();
  const parsedSpec = parseRegistryNpmSpec(params.spec);
  if (
    !parsedSpec ||
    !parsedSpec.name.startsWith("@openclaw/") ||
    !params.metadata.version ||
    isPrereleaseResolutionAllowed({
      spec: parsedSpec,
      resolvedVersion: params.metadata.version,
    })
  ) {
    return undefined;
  }
  const versions = await loadNpmPackageVersionsForUpdate({
    packageName: parsedSpec.name,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  const stableVersion = versions
    ?.filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(comparePackageUpdateVersions)
    .at(-1);
  if (stableVersion) {
    const stableMetadata = await resolveNpmSpecMetadata({
      spec: `${parsedSpec.name}@${stableVersion}`,
      timeoutMs: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    return stableMetadata.ok ? { kind: "stable", metadata: stableMetadata.metadata } : undefined;
  }

  const prereleaseVersion = versions
    ?.filter(isPrereleaseSemverVersion)
    .toSorted(comparePackageUpdateVersions)
    .at(-1);
  if (!prereleaseVersion || !versions?.every(isPrereleaseSemverVersion)) {
    return undefined;
  }
  if (prereleaseVersion === params.metadata.version) {
    return { kind: "prerelease-only", metadata: params.metadata };
  }
  const prereleaseMetadata = await resolveNpmSpecMetadata({
    spec: `${parsedSpec.name}@${prereleaseVersion}`,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  return prereleaseMetadata.ok
    ? { kind: "prerelease-only", metadata: prereleaseMetadata.metadata }
    : undefined;
}
