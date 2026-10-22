// ClawHub discovery and exact-artifact resolution for public Claws.
import fs from "node:fs/promises";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { stripFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import { downloadClawHubPackageArchive } from "../infra/clawhub-artifacts.js";
import {
  resolveClawHubBaseUrl,
  resolveClawHubImageUrl,
  type ClawHubFetchOptions,
} from "../infra/clawhub-client.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import { normalizeClawHubSha256Hex } from "../infra/clawhub-integrity.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  listClawHubPackages,
  searchClawHubPackages,
  type ClawHubPackageDetail,
  type ClawHubPackageListItem,
} from "../infra/clawhub-packages.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { parseClawManifestSummary } from "./clawhub-manifest-summary.js";
import {
  readClawHubCatalogPreview,
  type ClawHubClawCatalogPreview,
} from "./clawhub-preview-content.js";
import {
  CLAWHUB_TIMEOUT_MS,
  ClawHubSourceError,
  persistExtractedSource,
  readVerifiedArtifactSource,
  type ResolvedClawHubSource,
} from "./clawhub-source-artifact.js";
import { isCanonicalClawHubPackageName, isExactSemVer } from "./schema-portability.js";

export type { ClawHubClawCatalogPreview } from "./clawhub-preview-content.js";
export { ClawHubSourceError };

const CATALOG_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 20;
const MAX_CONTENT_EXCERPT_CHARS = 2048;

function toCatalogExcerpt(content: string | undefined): string {
  return content ? flattenMarkdownToPlainText(content).slice(0, MAX_CONTENT_EXCERPT_CHARS) : "";
}

export type ClawHubCoordinate = { packageName: string; version: string };
export type ClawHubClawCatalogEntry = {
  packageName: string;
  displayName: string;
  summary?: string;
  iconUrl?: string;
  latestVersion?: string;
  channel: "official" | "community";
  official: boolean;
  ownerHandle: string;
  downloads: number;
  installs: number;
  featuredAt?: number;
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
  contents: {
    instructions: Array<{ name: string; source: string; excerpt?: string }>;
    skills: Array<{ name: string; version: string; excerpt?: string }>;
    integrations: Array<{ name: string; kind: "plugin" | "mcpServer"; version?: string }>;
    automations: Array<{ name: string; schedule: string; timezone: string }>;
  };
  scanStatus?: string;
};
type AcceptedTrust = Extract<Awaited<ReturnType<typeof checkClawHubPackageTrust>>, { ok: true }>;
export type ClawHubClawTrust = {
  trustWarning?: string;
  riskAcknowledgementRequired: boolean;
  trustRecord: AcceptedTrust["trustInstallRecordFields"];
};

type PublicClawPackage = ClawHubPackageListItem & { channel: "official" | "community" };
type OwnedClawPackage = PublicClawPackage & { ownerHandle: string };

function isPublicClawPackage(pkg: unknown): pkg is PublicClawPackage {
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
    ((pkg.channel === "official" && pkg.isOfficial === true) ||
      (pkg.channel === "community" && pkg.isOfficial === false)) &&
    isCanonicalClawHubPackageName(pkg.name)
  );
}

function matchesClawPublisher(name: string, ownerHandle: unknown): ownerHandle is string {
  return (
    typeof ownerHandle === "string" &&
    ownerHandle.length > 0 &&
    (!name.startsWith("@") || name.slice(1, name.indexOf("/")) === ownerHandle)
  );
}

function isPublicClawListItem(pkg: unknown): pkg is OwnedClawPackage {
  return isPublicClawPackage(pkg) && matchesClawPublisher(pkg.name, pkg.ownerHandle);
}

function requirePublicClawPackage(
  detail: ClawHubPackageDetail,
  requestedName: string,
): OwnedClawPackage {
  const pkg = detail.package;
  const ownerHandle = detail.owner?.handle;
  if (
    !isPublicClawPackage(pkg) ||
    pkg.name !== requestedName ||
    !matchesClawPublisher(pkg.name, ownerHandle) ||
    (pkg.ownerHandle !== undefined && pkg.ownerHandle !== null && pkg.ownerHandle !== ownerHandle)
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub returned a different public Claw package identity.",
    );
  }
  return { ...pkg, ownerHandle, ownerOfficial: detail.owner?.official === true };
}

function requireClawName(packageName: string): void {
  if (!isCanonicalClawHubPackageName(packageName)) {
    throw new ClawHubSourceError(
      "clawhub_package_name_invalid",
      "Select a canonical ClawHub package name without a version selector.",
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

function projectCatalogEntry(pkg: OwnedClawPackage, baseUrl?: string): ClawHubClawCatalogEntry {
  const iconUrl = resolveClawHubImageUrl(
    typeof pkg.icon === "string" ? pkg.icon : undefined,
    baseUrl,
  );
  const downloads = pkg.stats?.downloads;
  const installs = pkg.stats?.installs;
  return {
    packageName: pkg.name,
    ...(iconUrl ? { iconUrl } : {}),
    displayName: pkg.displayName,
    ...(pkg.summary ? { summary: pkg.summary } : {}),
    ...(pkg.latestVersion ? { latestVersion: pkg.latestVersion } : {}),
    channel: pkg.channel,
    official: pkg.ownerOfficial === true,
    ownerHandle: pkg.ownerHandle,
    downloads:
      typeof downloads === "number" && Number.isFinite(downloads) ? Math.max(0, downloads) : 0,
    installs: typeof installs === "number" && Number.isFinite(installs) ? Math.max(0, installs) : 0,
    ...(typeof pkg.featuredAt === "number" ? { featuredAt: pkg.featuredAt } : {}),
    updatedAtMs: Math.max(0, pkg.updatedAt),
  };
}

function projectPublicEntries(packages: unknown[], baseUrl?: string): ClawHubClawCatalogEntry[] {
  return packages.filter(isPublicClawListItem).map((pkg) => projectCatalogEntry(pkg, baseUrl));
}

function rankByInstalls(left: ClawHubClawCatalogEntry, right: ClawHubClawCatalogEntry): number {
  return right.installs - left.installs || left.packageName.localeCompare(right.packageName);
}

function readExactClawArtifact(
  response: Awaited<ReturnType<typeof fetchClawHubPackageArtifact>>,
  coordinate: ClawHubCoordinate,
) {
  const artifactVersion =
    typeof response.version === "string" ? response.version : response.version?.version;
  if (
    response.package?.name !== coordinate.packageName ||
    response.package.family !== "claw" ||
    artifactVersion !== coordinate.version
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub artifact identity does not match the selected release.",
    );
  }
  const value: unknown = response.artifact;
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
  params: ClawHubFetchOptions & { limit?: number; category?: string; featured?: boolean } = {},
): Promise<ClawHubClawCatalogEntry[]> {
  const entries = new Map<string, ClawHubClawCatalogEntry>();
  const finish = () => {
    const result = [...entries.values()];
    return params.category && !params.featured ? result.toSorted(rankByInstalls) : result;
  };
  const seenCursors = new Set<string>();
  const requestedLimit =
    !params.category && params.limit && params.limit > 0 ? params.limit : undefined;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const result = await listClawHubPackages({
      ...params,
      family: "claw",
      category: params.category,
      featured: params.featured,
      limit: Math.min(
        CATALOG_PAGE_SIZE,
        requestedLimit ? requestedLimit - entries.size : CATALOG_PAGE_SIZE,
      ),
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of projectPublicEntries(result.items, params.baseUrl)) {
      entries.set(entry.packageName, entry);
      if (requestedLimit && entries.size >= requestedLimit) {
        return finish();
      }
    }
    if (result.nextCursor === null) {
      return finish();
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
  params: ClawHubFetchOptions & { query: string; limit?: number; category?: string },
): Promise<ClawHubClawCatalogEntry[]> {
  const query = params.query.trim();
  if (!query) {
    return await listClawHubClaws(params);
  }
  const results = await searchClawHubPackages({
    ...params,
    query,
    family: "claw",
    category: params.category,
    limit: params.limit ?? CATALOG_PAGE_SIZE,
  });
  const entries = projectPublicEntries(
    results.map((result) => result.package),
    params.baseUrl,
  );
  return params.category ? entries.toSorted(rankByInstalls) : entries;
}

export async function readClawHubClawDetail(
  params: ClawHubFetchOptions & { packageName: string; version?: string },
): Promise<ClawHubClawCatalogDetail> {
  requireClawName(params.packageName);
  const detail = await fetchClawHubPackageDetail({ ...params, name: params.packageName });
  const pkg = requirePublicClawPackage(detail, params.packageName);
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
  const { contents } = await readClawHubClawContents({
    ...params,
    packageName: pkg.name,
    version,
  });
  return {
    ...projectCatalogEntry({ ...pkg, icon: release.version.icon }, params.baseUrl),
    version,
    ...(summary.name ? { agentName: summary.name } : {}),
    ...(summary.description ? { agentDescription: summary.description } : {}),
    workspaceFiles: contents.instructions.length,
    skills: contents.skills.length,
    plugins: contents.integrations.filter((item) => item.kind === "plugin").length,
    mcpServers: contents.integrations.filter((item) => item.kind === "mcpServer").length,
    scheduledJobs: contents.automations.length,
    contents,
  };
}

export async function readClawHubClawPreview(
  params: ClawHubFetchOptions &
    ClawHubCoordinate & {
      kind: ClawHubClawCatalogPreview["kind"];
      name: string;
    },
): Promise<ClawHubClawCatalogPreview> {
  requireClawName(params.packageName);
  requireExactVersion(params.version);
  const detail = await fetchClawHubPackageDetail({ ...params, name: params.packageName });
  requirePublicClawPackage(detail, params.packageName);
  const { preview } = await readClawHubClawContents(params, {
    kind: params.kind,
    name: params.name,
  });
  if (!preview) {
    throw new ClawHubSourceError(
      "clawhub_preview_unavailable",
      "This item is not in the Claw release.",
    );
  }
  return preview;
}

async function readClawHubClawContents(
  params: ClawHubFetchOptions & ClawHubCoordinate,
  requestedPreview?: Pick<ClawHubClawCatalogPreview, "kind" | "name">,
): Promise<{
  contents: ClawHubClawCatalogDetail["contents"];
  preview?: ClawHubClawCatalogPreview;
}> {
  const artifactResponse = await fetchClawHubPackageArtifact({
    ...params,
    name: params.packageName,
  });
  const expected = readExactClawArtifact(artifactResponse, params);
  const download = await downloadClawHubPackageArchive({
    name: params.packageName,
    version: params.version,
    artifact: "clawpack",
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.token ? { token: params.token } : {}),
    timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
  });
  try {
    if (
      download.artifact !== "clawpack" ||
      download.sha256Hex !== expected.sha256 ||
      download.npmIntegrity !== expected.npmIntegrity ||
      (expected.npmShasum !== undefined && download.npmShasum !== expected.npmShasum)
    ) {
      throw new ClawHubSourceError(
        "clawhub_artifact_integrity_mismatch",
        "ClawHub artifact integrity changed during download.",
      );
    }
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-claw-catalog-",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md", "claw.json"],
      onExtracted: async (rootDir) => {
        const verified = await readVerifiedArtifactSource({
          sourceRoot: rootDir,
          packageName: params.packageName,
          version: params.version,
          artifactSha256: expected.sha256,
          artifactByteLength,
        });
        const manifest = verified.manifest;
        const instructions = [
          ...Object.entries(manifest.workspace.bootstrapFiles)
            .filter(([, declaration]) => Boolean(declaration))
            .map(([name, declaration]) => ({ name, source: declaration!.source })),
          ...manifest.workspace.files.map((file) => ({ name: file.path, source: file.source })),
        ];
        // Native first-run instructions are seeded outside the managed workspace declarations.
        if (verified.packageBootstrap) {
          instructions.push({ name: "BOOTSTRAP.md", source: verified.packageBootstrap.sourcePath });
        }
        if (verified.clawMarkdownBody && !instructions.some((file) => file.name === "SOUL.md")) {
          instructions.push({ name: "SOUL.md", source: "CLAW.md#body" });
        }
        const skills = manifest.packages
          .filter((pkg) => pkg.kind === "skill")
          .map((pkg) => ({ name: pkg.ref, version: pkg.version }));
        const [describedInstructions, describedSkills] = requestedPreview
          ? [instructions, skills]
          : await Promise.all([
              Promise.all(
                instructions.map(async (instruction) => {
                  const preview = await readClawHubCatalogPreview({
                    params,
                    requested: { kind: "instruction", name: instruction.name },
                    instructions,
                    skills,
                    verified,
                    rootDir,
                  });
                  const excerpt = toCatalogExcerpt(preview?.content);
                  return { ...instruction, ...(excerpt ? { excerpt } : {}) };
                }),
              ),
              Promise.all(
                skills.map(async (skill) => {
                  const preview = await readClawHubCatalogPreview({
                    params,
                    requested: { kind: "skill", name: skill.name },
                    instructions,
                    skills,
                    verified,
                    rootDir,
                  }).catch(() => undefined);
                  const excerpt = toCatalogExcerpt(
                    preview?.content ? stripFrontmatterBlock(preview.content) : undefined,
                  );
                  return { ...skill, ...(excerpt ? { excerpt } : {}) };
                }),
              ),
            ]);
        const preview = await readClawHubCatalogPreview({
          params,
          requested: requestedPreview,
          instructions,
          skills,
          verified,
          rootDir,
        });
        return {
          ok: true as const,
          value: {
            contents: {
              instructions: describedInstructions,
              skills: describedSkills,
              integrations: [
                ...manifest.packages
                  .filter((pkg) => pkg.kind === "plugin")
                  .map((pkg) => ({ name: pkg.ref, kind: "plugin" as const, version: pkg.version })),
                ...Object.keys(manifest.mcpServers).map((name) => ({
                  name,
                  kind: "mcpServer" as const,
                })),
              ],
              automations: manifest.cronJobs.map((job) => ({
                name: job.name || job.id,
                schedule: job.schedule.cron,
                timezone: job.schedule.timezone,
              })),
            },
            ...(preview ? { preview } : {}),
          },
        };
      },
    });
    if (!extracted.ok || !("value" in extracted)) {
      throw new ClawHubSourceError("clawhub_extract_failed", extracted.error);
    }
    return extracted.value;
  } finally {
    await download.cleanup();
  }
}

type PersistClawHubSource = () => Promise<ResolvedClawHubSource>;

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
  requireClawName(packageName);
  requireExactVersion(version);
  const detail = await fetchClawHubPackageDetail({ ...params, name: packageName });
  requirePublicClawPackage(detail, packageName);
  const artifact = await fetchClawHubPackageArtifact({ ...params, name: packageName, version });
  const resolvedArtifact = readExactClawArtifact(artifact, params.coordinate);
  const expectedSha256 = resolvedArtifact.sha256;
  const trust = await checkClawHubPackageTrust({
    subject: { kind: "claw", packageName },
    version,
    expectedClawArtifact: {
      sha256: expectedSha256,
      npmIntegrity: resolvedArtifact.npmIntegrity,
      ...(resolvedArtifact.npmShasum !== undefined
        ? { npmShasum: resolvedArtifact.npmShasum }
        : {}),
    },
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
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
  });
  try {
    if (
      download.artifact !== "clawpack" ||
      download.sha256Hex !== expectedSha256 ||
      download.npmIntegrity !== resolvedArtifact.npmIntegrity ||
      (resolvedArtifact.npmShasum !== undefined &&
        download.npmShasum !== resolvedArtifact.npmShasum)
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
        if (
          params.baseUrl !== undefined &&
          resolveClawHubBaseUrl(params.baseUrl) !== resolveClawHubBaseUrl() &&
          artifactSource.manifest.packages.length > 0
        ) {
          throw new ClawHubSourceError(
            "clawhub_registry_mismatch",
            "ClawHub Claw dependencies require the configured registry.",
          );
        }
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
              archivePath: download.archivePath,
              artifactSha256: expectedSha256,
              artifactByteLength,
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
