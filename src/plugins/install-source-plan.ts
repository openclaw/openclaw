import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { isDefaultClawHubBaseUrl } from "../infra/clawhub-client.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { looksLikeLocalInstallSpec } from "../infra/install-spec.js";
import { resolveUserPath } from "../utils.js";
import { findBundledPluginSource, type BundledPluginSource } from "./bundled-sources.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
import { parseGitPluginSpec } from "./git-install.js";
import {
  resolveOpenClawTrustedNpmPackageInstall,
  type NonClawHubInstallSourceClass,
} from "./install-provenance.js";
import {
  isBareNpmPackageName,
  resolveBundledInstallPlanBeforeNpm,
  type BundledLookup,
  parseNpmPackPrefixPath,
  parseNpmPrefixSpec,
  resolveFileNpmSpecToLocalPath,
} from "./install-source-spec.js";
import { resolveOfficialEntryById } from "./management-catalog.js";
import type { ManagedPluginSourceInstallRequest } from "./management-install.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  resolveCatalogOfficialExternalInstallPlan,
  resolveOfficialInstallSources,
} from "./official-external-install-trust.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";

function isLocalGitUrl(url: string): boolean {
  return (
    path.isAbsolute(url) ||
    url.startsWith("file:") ||
    (!URL.canParse(url) && !/^[^@\s]+@[^:\s]+:.+/.test(url))
  );
}

/** Local artifacts belong to the connecting host, not a remote Gateway's filesystem. */
export function pluginInstallRequiresLocalHost(request: PluginsInstallParams): boolean {
  if (
    request.source === "local" ||
    request.source === "npm-pack" ||
    request.source === "marketplace"
  ) {
    return true;
  }
  if (request.source === "git") {
    const parsed = parseGitPluginSpec(request.spec);
    return parsed !== null && isLocalGitUrl(parsed.url);
  }
  return false;
}

type PluginInstallSourcePlan =
  | { ok: false; error: string }
  | {
      ok: true;
      request: PluginsInstallParams;
      warning?: string;
      localPath?: string;
      acknowledgement?: { sourceClass: NonClawHubInstallSourceClass; spec: string };
    };

function sourcePlan(
  request: PluginsInstallParams,
  raw: string,
  sourceClass?: NonClawHubInstallSourceClass,
  metadata: { warning?: string; localPath?: string } = {},
): PluginInstallSourcePlan {
  return {
    ok: true,
    request,
    ...metadata,
    ...(sourceClass ? { acknowledgement: { sourceClass, spec: raw } } : {}),
  };
}

export function resolvePluginInstallSourcePlan(params: {
  raw: string;
  mode: "install" | "update";
  link?: boolean;
  pin?: boolean;
}): PluginInstallSourcePlan {
  const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
  if (fileSpec && !fileSpec.ok) {
    return fileSpec;
  }
  const normalized = fileSpec?.path ?? params.raw;
  const resolved = resolveUserPath(normalized);
  if (fs.existsSync(resolved)) {
    const recordSource = resolveArchiveKind(resolved) ? "archive" : "path";
    const bundled =
      recordSource === "path"
        ? findBundledPluginSource({ lookup: { kind: "localPath", value: resolved } })
        : undefined;
    return sourcePlan(
      {
        source: "local",
        path: resolved,
        mode: params.mode,
        ...(params.link ? { link: true } : {}),
      },
      params.raw,
      bundled ? undefined : recordSource === "archive" ? "local-archive" : "local-path",
    );
  }

  const npmPackPath = parseNpmPackPrefixPath(params.raw);
  if (npmPackPath !== null) {
    return npmPackPath
      ? sourcePlan(
          { source: "npm-pack", archivePath: resolveUserPath(npmPackPath), mode: params.mode },
          params.raw,
          "npm-pack",
        )
      : { ok: false, error: "Unsupported npm-pack plugin spec: missing archive path." };
  }
  const gitPrefix = params.raw.trim().toLowerCase().startsWith("git:");
  const git = parseGitPluginSpec(params.raw);
  if (gitPrefix) {
    return git
      ? sourcePlan(
          {
            source: "git",
            spec:
              isLocalGitUrl(git.url) && !git.url.startsWith("file:")
                ? `git:${pathToFileURL(resolveUserPath(git.url)).href}${git.ref ? `@${git.ref}` : ""}`
                : params.raw,
            mode: params.mode,
          },
          params.raw,
          "git",
        )
      : { ok: false, error: `unsupported git: plugin spec: ${params.raw}` };
  }
  function planClawHub(parsed: ReturnType<typeof parseClawHubPluginSpec>): PluginInstallSourcePlan {
    return parsed
      ? sourcePlan(
          {
            source: "clawhub",
            packageName: parsed.name,
            version: parsed.version,
            mode: params.mode,
          },
          params.raw,
        )
      : { ok: false, error: `Unsupported ClawHub plugin spec: ${params.raw}` };
  }
  const clawhubPrefix = params.raw.trim().toLowerCase().startsWith("clawhub:");
  if (clawhubPrefix) {
    return planClawHub(parseClawHubPluginSpec(params.raw));
  }
  const explicitNpm = parseNpmPrefixSpec(params.raw);
  if (explicitNpm !== null && !explicitNpm) {
    return { ok: false, error: "Unsupported npm plugin spec: missing package." };
  }
  if (
    explicitNpm === null &&
    (fileSpec !== null ||
      looksLikeLocalInstallSpec(
        params.raw,
        params.raw.includes("/") ? [] : [".tgz", ".tar.gz", ".tar", ".zip"],
      ))
  ) {
    return { ok: false, error: `Plugin path not found: ${resolved}` };
  }

  const bundledPlan = resolveBundledInstallPlanBeforeNpm({
    rawSpec: params.raw,
    findBundledSource: (lookup) => findBundledPluginSource({ lookup }),
  });
  if (bundledPlan) {
    return sourcePlan(
      {
        source: "bundled",
        pluginId: bundledPlan.bundledSource.pluginId,
        spec: params.raw,
      },
      params.raw,
      undefined,
      { warning: bundledPlan.warning, localPath: bundledPlan.bundledSource.localPath },
    );
  }
  const official =
    explicitNpm === null && isBareNpmPackageName(params.raw)
      ? resolveCatalogOfficialExternalInstallPlan(params.raw)
      : null;
  if (official && official.pluginId === params.raw.trim()) {
    return sourcePlan(
      {
        source: "official",
        pluginId: official.pluginId,
        mode: params.mode,
        ...(params.pin ? { pin: true } : {}),
      },
      params.raw,
    );
  }
  if (explicitNpm === null) {
    // Keep the selected registry explicit downstream, including persisted update provenance.
    const defaultClawHub = params.raw.includes(":")
      ? null
      : parseClawHubPluginSpec(`clawhub:${params.raw}`);
    return planClawHub(defaultClawHub);
  }
  const trusted = resolveOpenClawTrustedNpmPackageInstall(explicitNpm);
  return sourcePlan(
    {
      source: "npm",
      spec: explicitNpm,
      mode: params.mode,
      ...(params.pin ? { pin: true } : {}),
    },
    params.raw,
    trusted ? undefined : "npm",
  );
}

export function resolveBundledInstallPlanForCatalogEntry(params: {
  pluginId: string;
  npmSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource } | null {
  const pluginId = params.pluginId.trim();
  const npmSpec = params.npmSpec.trim();
  if (!pluginId || !npmSpec) {
    return null;
  }

  const bundledBySpec = params.findBundledSource({
    kind: "npmSpec",
    value: npmSpec,
  });
  if (bundledBySpec?.pluginId === pluginId) {
    return { bundledSource: bundledBySpec };
  }

  const bundledById = params.findBundledSource({
    kind: "pluginId",
    value: pluginId,
  });
  if (
    bundledById?.pluginId !== pluginId ||
    (bundledById.npmSpec && bundledById.npmSpec !== npmSpec)
  ) {
    return null;
  }

  return { bundledSource: bundledById };
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) =>
    resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    ),
  );
}

/** Public requests carry intent and constraints; catalog provenance is resolved by this owner. */
export function resolveManagedPluginInstallRequest(
  request: PluginsInstallParams,
  officialEntries: readonly OfficialExternalPluginCatalogEntry[],
  clawhubUrl: string,
): ManagedPluginSourceInstallRequest {
  const mode = request.mode ?? "install";
  switch (request.source) {
    case "official": {
      const entry =
        resolveOfficialEntryById(officialEntries, request.pluginId) ??
        resolveOfficialEntryById(listOfficialExternalPluginCatalogEntries(), request.pluginId);
      if (!entry) {
        throw new ManagedPluginLifecycleError(
          `unknown official plugin catalog entry: ${request.pluginId}`,
        );
      }
      const pluginId = resolveOfficialExternalPluginId(entry);
      const install = resolveOfficialExternalPluginInstall(entry);
      if (!pluginId || !install) {
        throw new ManagedPluginLifecycleError(
          `official plugin catalog entry is not installable: ${request.pluginId}`,
        );
      }
      const bundled =
        !request.version && !request.pin
          ? findBundledPluginSource({ lookup: { kind: "pluginId", value: pluginId } })
          : undefined;
      if (
        bundled &&
        isBundledPluginInsideDevSourceRoot({ rootDir: bundled.localPath, env: process.env })
      ) {
        return { source: "bundled", rawSpec: install.npmSpec ?? pluginId, bundledSource: bundled };
      }
      const installSources = resolveOfficialInstallSources(entry, request.version);
      const primary = installSources[0];
      if (!primary) {
        throw new ManagedPluginLifecycleError(
          `official plugin catalog entry has no supported install source: ${request.pluginId}`,
        );
      }
      return {
        source: "official",
        clawhubUrl,
        spec: primary.spec,
        installSources,
        expectedPluginId: resolveDeclaredOfficialPluginId(entry),
        mode,
        ...(request.pin ? { pin: true } : {}),
      };
    }
    case "clawhub": {
      const packageName = request.packageName.trim();
      // Public catalog identity and artifact pins do not describe another registry's package.
      const useOfficialCatalog = isDefaultClawHubBaseUrl(clawhubUrl);
      const official = useOfficialCatalog
        ? resolveOfficialEntryByClawHubPackage(
            [...listOfficialExternalPluginCatalogEntries(), ...officialEntries],
            packageName,
          )
        : undefined;
      // Pin the runtime id only when the catalog entry declares one; the entry-id
      // fallback is just the package name and would reject legitimate installs.
      const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
      const hostedOfficial = useOfficialCatalog
        ? resolveOfficialEntryByClawHubPackage(officialEntries, packageName)
        : undefined;
      const hostedSource = hostedOfficial
        ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
            (source) => source.source === "clawhub",
          )
        : undefined;
      const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
      const requestMatchesHostedCandidate =
        !request.version || request.version === hostedClawHub?.version;
      const version = request.version ?? hostedClawHub?.version;
      const expectedIntegrity = requestMatchesHostedCandidate
        ? hostedSource?.expectedIntegrity
        : undefined;
      const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
      if (!parsed || parsed.version) {
        throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
      }

      if (
        expectedPluginId &&
        request.expectedPluginId &&
        expectedPluginId !== request.expectedPluginId
      ) {
        throw new ManagedPluginLifecycleError(
          "Requested plugin identity differs from the official catalog.",
        );
      }
      if (
        expectedIntegrity &&
        request.expectedIntegrity &&
        expectedIntegrity !== normalizeClawHubSha256Integrity(request.expectedIntegrity)
      ) {
        throw new ManagedPluginLifecycleError(
          "Requested artifact integrity differs from the official catalog.",
        );
      }
      return {
        source: "clawhub",
        clawhubUrl,
        spec: `clawhub:${packageName}${version ? `@${version}` : ""}`,
        ...(!request.version && !request.expectedIntegrity
          ? { recordSpec: `clawhub:${packageName}` }
          : {}),
        mode,
        ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
        expectedPluginId: expectedPluginId ?? request.expectedPluginId,
        expectedIntegrity: expectedIntegrity ?? request.expectedIntegrity,
      };
    }
    case "bundled": {
      const bundledSource = findBundledPluginSource({
        lookup: { kind: "pluginId", value: request.pluginId },
      });
      if (!bundledSource) {
        throw new ManagedPluginLifecycleError(`Unknown bundled plugin: ${request.pluginId}`);
      }
      return { source: "bundled", rawSpec: request.spec ?? request.pluginId, bundledSource };
    }
    case "local": {
      const resolved = resolveUserPath(request.path);
      const bundled = findBundledPluginSource({ lookup: { kind: "localPath", value: resolved } });
      return {
        source: "local",
        path: resolved,
        mode,
        recordSource: resolveArchiveKind(resolved) ? "archive" : "path",
        ...(request.link ? { link: true } : {}),
        ...(bundled ? { bundledOrigin: true } : {}),
      };
    }
    case "npm": {
      const trusted = resolveOpenClawTrustedNpmPackageInstall(request.spec);
      if (trusted && request.expectedPluginId && trusted.pluginId !== request.expectedPluginId) {
        throw new ManagedPluginLifecycleError(
          "Requested plugin identity differs from the official npm identity.",
        );
      }
      if (
        trusted?.expectedIntegrity &&
        request.expectedIntegrity &&
        trusted.expectedIntegrity !== request.expectedIntegrity.trim()
      ) {
        throw new ManagedPluginLifecycleError(
          "Requested artifact integrity differs from the official npm artifact.",
        );
      }
      return {
        ...request,
        mode,
        ...(trusted ? { trustedSourceLinkedOfficialInstall: true } : {}),
        expectedPluginId: trusted?.pluginId ?? request.expectedPluginId,
        expectedIntegrity: trusted?.expectedIntegrity ?? request.expectedIntegrity,
      };
    }
    case "npm-pack":
    case "git":
    case "marketplace":
      return { ...request, mode };
    default:
      throw new ManagedPluginLifecycleError("Unsupported plugin install source.");
  }
}
