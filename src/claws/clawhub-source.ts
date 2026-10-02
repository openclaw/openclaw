// ClawHub discovery and exact-artifact resolution for official Claws.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { downloadClawHubPackageArchive } from "../infra/clawhub-artifacts.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import { normalizeClawHubSha256Hex } from "../infra/clawhub-integrity.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  listClawHubPackages,
  searchClawHubPackages,
  type ClawHubClawManifestSummary,
  type ClawHubPackageDetail,
  type ClawHubPackageListItem,
} from "../infra/clawhub-packages.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { readClawManifestFile } from "./reader.js";
import { isExactSemVer } from "./schema-portability.js";
import type { ClawReadResult, ClawSourceIdentity } from "./types.js";

const CLAW_SOURCE_CACHE_DIR = "claws/sources";
const CLAWHUB_TIMEOUT_MS = 30_000;
const CATALOG_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 20;

export type ClawHubCoordinate = { packageName: string; version: string };
export type ClawHubClawCatalogEntry = {
  packageName: string;
  displayName: string;
  summary?: string;
  latestVersion?: string;
  channel: "official";
  official: true;
  downloads: number;
  updatedAtMs: number;
};
export type ClawHubClawCatalogDetail = ClawHubClawCatalogEntry & {
  version: string;
  agentName?: string;
  agentDescription?: string;
  workspaceFiles: number;
  skills: number;
  plugins: number;
  mcpServers: number;
  scheduledJobs: number;
  scanStatus?: string;
};
type AcceptedTrust = Extract<Awaited<ReturnType<typeof checkClawHubPackageTrust>>, { ok: true }>;
export type ClawHubClawTrust = {
  trustWarning?: string;
  riskAcknowledgementRequired: boolean;
  trustRecord: AcceptedTrust["trustInstallRecordFields"];
};

export class ClawHubSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly warning?: string,
  ) {
    super(message);
    this.name = "ClawHubSourceError";
  }
}

function isOfficialClawName(name: string): boolean {
  const spec = parseRegistryNpmSpec(name);
  return spec?.selectorKind === "none" && spec.name === name && name.startsWith("@openclaw/");
}

function isOfficialClawPackage(pkg: unknown): pkg is ClawHubPackageListItem {
  return (
    isJsonObject(pkg) &&
    typeof pkg.name === "string" &&
    typeof pkg.displayName === "string" &&
    typeof pkg.updatedAt === "number" &&
    Number.isFinite(pkg.updatedAt) &&
    (pkg.summary === undefined || pkg.summary === null || typeof pkg.summary === "string") &&
    (pkg.latestVersion === undefined ||
      pkg.latestVersion === null ||
      typeof pkg.latestVersion === "string") &&
    pkg.family === "claw" &&
    pkg.channel === "official" &&
    pkg.isOfficial === true &&
    isOfficialClawName(pkg.name)
  );
}

function isOfficialClawListItem(pkg: unknown): pkg is ClawHubPackageListItem {
  return isOfficialClawPackage(pkg) && pkg.ownerHandle === "openclaw";
}

function requireOfficialClawPackage(detail: ClawHubPackageDetail, requestedName: string) {
  const pkg = detail.package;
  if (
    !pkg ||
    !isOfficialClawPackage(pkg) ||
    pkg.name !== requestedName ||
    detail.owner?.handle !== "openclaw" ||
    (pkg.ownerHandle !== undefined && pkg.ownerHandle !== null && pkg.ownerHandle !== "openclaw")
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub returned a different official Claw package identity.",
    );
  }
  return pkg;
}

function requireOfficialName(packageName: string): void {
  if (!isOfficialClawName(packageName)) {
    throw new ClawHubSourceError(
      "clawhub_official_claw_required",
      "Only official OpenClaw Claws may be selected.",
    );
  }
}

function requireExactVersion(version: string): void {
  if (!isExactSemVer(version)) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "Select an exact published Claw version.",
    );
  }
}

function projectCatalogEntry(pkg: ClawHubPackageListItem): ClawHubClawCatalogEntry {
  const downloads = pkg.stats?.downloads;
  return {
    packageName: pkg.name,
    displayName: pkg.displayName,
    ...(pkg.summary ? { summary: pkg.summary } : {}),
    ...(pkg.latestVersion ? { latestVersion: pkg.latestVersion } : {}),
    channel: "official",
    official: true,
    downloads:
      typeof downloads === "number" && Number.isFinite(downloads) ? Math.max(0, downloads) : 0,
    updatedAtMs: Math.max(0, pkg.updatedAt),
  };
}

function projectOfficialEntries(packages: unknown[]): ClawHubClawCatalogEntry[] {
  return packages.filter(isOfficialClawListItem).map(projectCatalogEntry);
}

function readExactClawArtifact(value: unknown, coordinate: ClawHubCoordinate) {
  if (!isJsonObject(value)) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub returned no Claw artifact.",
    );
  }
  const kind = value.kind ?? value.artifactKind;
  if (
    kind !== "npm-pack" ||
    (value.kind !== undefined &&
      value.artifactKind !== undefined &&
      value.kind !== value.artifactKind) ||
    (value.source !== undefined && value.source !== "clawhub") ||
    (value.packageName !== undefined && value.packageName !== coordinate.packageName) ||
    (value.version !== undefined && value.version !== coordinate.version)
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub artifact identity does not match the selected release.",
    );
  }
  const modernSha256 =
    typeof value.sha256 === "string" ? normalizeClawHubSha256Hex(value.sha256) : null;
  const legacySha256 =
    typeof value.artifactSha256 === "string"
      ? normalizeClawHubSha256Hex(value.artifactSha256)
      : null;
  const sha256 = modernSha256 ?? legacySha256;
  if (
    !sha256 ||
    (value.sha256 !== undefined && !modernSha256) ||
    (value.artifactSha256 !== undefined && !legacySha256) ||
    (modernSha256 && legacySha256 && modernSha256 !== legacySha256) ||
    typeof value.npmIntegrity !== "string" ||
    !value.npmIntegrity.trim()
  ) {
    throw new ClawHubSourceError(
      "clawhub_artifact_unavailable",
      "ClawHub did not return valid immutable Claw artifact integrity.",
    );
  }
  return {
    sha256,
    npmIntegrity: value.npmIntegrity,
    ...(typeof value.npmShasum === "string" ? { npmShasum: value.npmShasum } : {}),
  };
}

export async function listClawHubClaws(
  params: ClawHubFetchOptions = {},
): Promise<ClawHubClawCatalogEntry[]> {
  const entries = new Map<string, ClawHubClawCatalogEntry>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const result = await listClawHubPackages({
      ...params,
      family: "claw",
      isOfficial: true,
      limit: CATALOG_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of projectOfficialEntries(result.items)) {
      entries.set(entry.packageName, entry);
    }
    if (result.nextCursor === null) {
      return [...entries.values()];
    }
    if (!result.nextCursor || seenCursors.has(result.nextCursor)) {
      throw new ClawHubSourceError(
        "clawhub_catalog_cursor_invalid",
        "ClawHub returned a repeating catalog cursor.",
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ClawHubSourceError(
    "clawhub_catalog_too_large",
    "ClawHub returned too many catalog pages for this request.",
  );
}

export async function searchClawHubClaws(
  params: ClawHubFetchOptions & { query: string; limit?: number },
): Promise<ClawHubClawCatalogEntry[]> {
  const query = params.query.trim();
  if (!query) {
    return await listClawHubClaws(params);
  }
  const results = await searchClawHubPackages({
    ...params,
    query,
    family: "claw",
    isOfficial: true,
    limit: params.limit ?? CATALOG_PAGE_SIZE,
  });
  return projectOfficialEntries(results.map((result) => result.package));
}

function parseClawManifestSummary(value: unknown): ClawHubClawManifestSummary {
  if (!isJsonObject(value) || value.schemaVersion !== 1) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Claw summary.",
    );
  }
  const { agent, workspace, packages } = value;
  const isCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (
    !isJsonObject(agent) ||
    typeof agent.id !== "string" ||
    !agent.id ||
    (agent.name !== undefined && typeof agent.name !== "string") ||
    (agent.description !== undefined && typeof agent.description !== "string") ||
    !isJsonObject(workspace) ||
    !Array.isArray(workspace.bootstrapFiles) ||
    !workspace.bootstrapFiles.every((file) => typeof file === "string") ||
    !isCount(workspace.fileCount) ||
    !isJsonObject(packages) ||
    !isCount(packages.skillCount) ||
    !isCount(packages.pluginCount) ||
    !isCount(value.mcpServerCount) ||
    !isCount(value.cronJobCount)
  ) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Claw summary.",
    );
  }
  return {
    schemaVersion: 1,
    agent: {
      id: agent.id,
      ...(typeof agent.name === "string" ? { name: agent.name } : {}),
      ...(typeof agent.description === "string" ? { description: agent.description } : {}),
    },
    workspace: { bootstrapFiles: workspace.bootstrapFiles, fileCount: workspace.fileCount },
    packages: { skillCount: packages.skillCount, pluginCount: packages.pluginCount },
    mcpServerCount: value.mcpServerCount,
    cronJobCount: value.cronJobCount,
  };
}

export async function readClawHubClawDetail(
  params: ClawHubFetchOptions & { packageName: string; version?: string },
): Promise<ClawHubClawCatalogDetail> {
  requireOfficialName(params.packageName);
  const detail = await fetchClawHubPackageDetail({ ...params, name: params.packageName });
  const pkg = requireOfficialClawPackage(detail, params.packageName);
  const version = params.version ?? pkg.latestVersion;
  if (!version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub has no published version.",
    );
  }
  requireExactVersion(version);
  const release = await fetchClawHubPackageVersion({ ...params, name: pkg.name, version });
  if (release.package?.name !== pkg.name || release.package.family !== "claw") {
    throw new ClawHubSourceError("clawhub_identity_mismatch", "ClawHub release identity changed.");
  }
  if (!release.version || release.version.version !== version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub release identity changed.",
    );
  }
  const summary = parseClawManifestSummary(release.version.clawManifestSummary);
  return {
    ...projectCatalogEntry(pkg),
    version,
    ...(summary.agent.name ? { agentName: summary.agent.name } : {}),
    ...(summary.agent.description ? { agentDescription: summary.agent.description } : {}),
    workspaceFiles: summary.workspace.fileCount + summary.workspace.bootstrapFiles.length,
    skills: summary.packages.skillCount,
    plugins: summary.packages.pluginCount,
    mcpServers: summary.mcpServerCount,
    scheduledJobs: summary.cronJobCount,
  };
}

async function sourceDirectoriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.lstat(left), fs.lstat(right)]);
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) {
    return false;
  }
  const [leftEntries, rightEntries] = await Promise.all([
    fs.readdir(left, { withFileTypes: true }),
    fs.readdir(right, { withFileTypes: true }),
  ]);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  const rightByName = new Map(rightEntries.map((entry) => [entry.name, entry]));
  for (const leftEntry of leftEntries) {
    const rightEntry = rightByName.get(leftEntry.name);
    if (!rightEntry) {
      return false;
    }
    const leftPath = path.join(left, leftEntry.name);
    const rightPath = path.join(right, leftEntry.name);
    if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
      if (!(await sourceDirectoriesMatch(leftPath, rightPath))) {
        return false;
      }
    } else if (leftEntry.isFile() && rightEntry.isFile()) {
      if (!(await fs.readFile(leftPath)).equals(await fs.readFile(rightPath))) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

async function persistExtractedSource(params: {
  rootDir: string;
  artifactSha256: string;
  stateDir?: string;
}): Promise<string> {
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), CLAW_SOURCE_CACHE_DIR);
  const destination = path.join(cacheRoot, params.artifactSha256);
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(cacheRoot, ".staging-"));
  const stagedPackage = path.join(staging, "package");
  try {
    await fs.cp(params.rootDir, stagedPackage, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    try {
      await fs.rename(stagedPackage, destination);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw error;
      }
      if (!(await sourceDirectoriesMatch(stagedPackage, destination))) {
        throw new ClawHubSourceError(
          "clawhub_cached_source_mismatch",
          "A cached Claw source differs from the verified release artifact.",
        );
      }
    }
    return destination;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

type ResolvedClawHubSource = Extract<ClawReadResult, { ok: true }>;
type PersistClawHubSource = () => Promise<ResolvedClawHubSource>;

async function readVerifiedArtifactSource(params: {
  sourceRoot: string;
  packageName: string;
  version: string;
  artifactSha256: string;
  artifactByteLength: number;
}): Promise<ResolvedClawHubSource> {
  const loaded = await readClawManifestFile(params.sourceRoot);
  if (!loaded.ok) {
    throw new ClawHubSourceError(
      "clawhub_manifest_invalid",
      "Downloaded Claw package manifest is invalid.",
    );
  }
  if (
    loaded.source.kind !== "package" ||
    loaded.source.name !== params.packageName ||
    loaded.source.version !== params.version
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "Downloaded Claw package identity does not match the selected release.",
    );
  }
  return {
    ...loaded,
    source: {
      ...loaded.source,
      integrityKind: "artifact",
      integrity: `sha256:${params.artifactSha256}`,
      byteLength: params.artifactByteLength,
    },
  };
}

export async function readMatchingCachedClawHubSource(params: {
  recorded: ClawSourceIdentity;
  verified: ResolvedClawHubSource;
  trust: ClawHubClawTrust;
  stateDir?: string;
}): Promise<ResolvedClawHubSource> {
  const { recorded, verified } = params;
  if (
    recorded.kind !== "package" ||
    recorded.integrityKind !== "artifact" ||
    verified.source.kind !== "package" ||
    verified.source.integrityKind !== "artifact" ||
    recorded.name !== verified.source.name ||
    recorded.version !== verified.source.version ||
    recorded.integrity !== verified.source.integrity ||
    recorded.byteLength !== verified.source.byteLength ||
    !/^sha256:[a-f0-9]{64}$/.test(verified.source.integrity)
  ) {
    throw new ClawHubSourceError(
      "clawhub_recorded_artifact_mismatch",
      "The recorded Claw artifact does not match the verified ClawHub release.",
    );
  }
  const digest = verified.source.integrity.slice("sha256:".length);
  const cacheRoot = path.join(params.stateDir ?? resolveStateDir(), CLAW_SOURCE_CACHE_DIR, digest);
  const cacheEntry = await fs.lstat(cacheRoot).catch(() => undefined);
  const canonicalCacheRoot = await fs.realpath(cacheRoot).catch(() => undefined);
  if (
    !cacheEntry?.isDirectory() ||
    !canonicalCacheRoot ||
    recorded.packageRoot !== canonicalCacheRoot
  ) {
    throw new ClawHubSourceError(
      "clawhub_recorded_source_unavailable",
      "The recorded Claw source is not in the verified ClawHub cache.",
    );
  }
  const matches = await sourceDirectoriesMatch(verified.source.packageRoot, cacheRoot).catch(
    () => false,
  );
  if (!matches) {
    throw new ClawHubSourceError(
      "clawhub_cached_source_mismatch",
      "The recorded Claw source differs from the verified release artifact.",
    );
  }
  const cached = await readVerifiedArtifactSource({
    sourceRoot: cacheRoot,
    packageName: recorded.name,
    version: recorded.version,
    artifactSha256: digest,
    artifactByteLength: recorded.byteLength,
  });
  if (cached.source.manifestPath !== recorded.manifestPath) {
    throw new ClawHubSourceError(
      "clawhub_recorded_source_mismatch",
      "The recorded Claw manifest path differs from the verified release artifact.",
    );
  }
  return {
    ...cached,
    diagnostics: [
      ...cached.diagnostics,
      ...(params.trust.trustWarning
        ? [
            {
              level: "warning" as const,
              code: "clawhub_trust_warning",
              phase: "plan" as const,
              path: "$",
              message: params.trust.trustWarning,
            },
          ]
        : []),
    ],
  };
}

export async function withResolvedClawHubSource<T>(
  params: ClawHubFetchOptions & {
    coordinate: ClawHubCoordinate;
    mode: "preview" | "apply";
    acknowledgeClawHubRisk?: boolean;
    stateDir?: string;
    run: (
      source: ResolvedClawHubSource,
      trust: ClawHubClawTrust,
      persistSource: PersistClawHubSource,
    ) => Promise<T>;
  },
): Promise<{ value: T } & ClawHubClawTrust> {
  const { packageName, version } = params.coordinate;
  requireOfficialName(packageName);
  requireExactVersion(version);
  const detail = await fetchClawHubPackageDetail({ ...params, name: packageName });
  requireOfficialClawPackage(detail, packageName);
  const artifact = await fetchClawHubPackageArtifact({ ...params, name: packageName, version });
  const artifactVersion =
    typeof artifact.version === "string" ? artifact.version : artifact.version?.version;
  if (
    artifact.package?.name !== packageName ||
    artifact.package.family !== "claw" ||
    artifactVersion !== version
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub artifact identity does not match the selected release.",
    );
  }
  const resolvedArtifact = readExactClawArtifact(artifact.artifact, params.coordinate);
  const expectedSha256 = resolvedArtifact.sha256;
  const trust = await checkClawHubPackageTrust({
    subject: { kind: "claw", packageName },
    version,
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!trust.ok) {
    throw new ClawHubSourceError(trust.code ?? "clawhub_trust_failed", trust.error, trust.warning);
  }
  const riskAcknowledgementRequired =
    trust.trustInstallRecordFields.clawhubTrustDisposition === "review-required";
  if (params.mode === "apply" && riskAcknowledgementRequired && !params.acknowledgeClawHubRisk) {
    throw new ClawHubSourceError(
      "clawhub_risk_acknowledgement_required",
      "Explicit acknowledgement is required for this ClawHub release.",
      trust.warning,
    );
  }
  const trustProjection: ClawHubClawTrust = {
    ...(trust.warning ? { trustWarning: trust.warning } : {}),
    riskAcknowledgementRequired,
    trustRecord: trust.trustInstallRecordFields,
  };

  const download = await downloadClawHubPackageArchive({
    name: packageName,
    version,
    artifact: "clawpack",
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
    fetchImpl: params.fetchImpl,
  });
  try {
    if (
      download.artifact !== "clawpack" ||
      download.sha256Hex !== expectedSha256 ||
      download.npmIntegrity !== resolvedArtifact.npmIntegrity ||
      (resolvedArtifact.npmShasum && download.npmShasum !== resolvedArtifact.npmShasum)
    ) {
      throw new ClawHubSourceError(
        "clawhub_artifact_integrity_mismatch",
        "ClawHub artifact integrity changed during download.",
      );
    }
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-claw-source-",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md", "claw.json"],
      onExtracted: async (rootDir) => {
        const artifactSource = await readVerifiedArtifactSource({
          sourceRoot: rootDir,
          packageName,
          version,
          artifactSha256: expectedSha256,
          artifactByteLength,
        });
        let persistedSource: Promise<ResolvedClawHubSource> | undefined;
        const persistSource: PersistClawHubSource = async () => {
          if (params.mode !== "apply") {
            throw new ClawHubSourceError(
              "clawhub_preview_persistence_forbidden",
              "A ClawHub preview cannot persist package content.",
            );
          }
          persistedSource ??= (async () => {
            const sourceRoot = await persistExtractedSource({
              rootDir,
              artifactSha256: expectedSha256,
              stateDir: params.stateDir,
            });
            return await readVerifiedArtifactSource({
              sourceRoot,
              packageName,
              version,
              artifactSha256: expectedSha256,
              artifactByteLength,
            });
          })();
          return await persistedSource;
        };
        return {
          ok: true as const,
          value: await params.run(artifactSource, trustProjection, persistSource),
        };
      },
    });
    if (!extracted.ok || !("value" in extracted)) {
      throw new ClawHubSourceError("clawhub_extract_failed", extracted.error);
    }
    return { value: extracted.value, ...trustProjection };
  } finally {
    await download.cleanup();
  }
}
