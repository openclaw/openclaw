// ClawHub discovery and exact-artifact resolution for public Templates.
import fs from "node:fs/promises";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import type { TemplatesCatalogDetailResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import { stripFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import {
  downloadClawHubPackageArchive,
  type ClawHubDownloadResult,
} from "../infra/clawhub-artifacts.js";
import {
  resolveClawHubBaseUrl,
  resolveClawHubImageUrl,
  type ClawHubFetchOptions,
} from "../infra/clawhub-client.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageVersion,
  fetchClawHubTemplatesOverview,
  listClawHubPackages,
  searchClawHubPackages,
  type ClawHubPackageDetail,
  type ClawHubPackageListItem,
} from "../infra/clawhub-packages.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { projectTemplateCatalogDependencies } from "./catalog-dependencies.js";
import { parseTemplateManifestSummary } from "./clawhub-manifest-summary.js";
import {
  readClawHubCatalogPreview,
  type ClawHubTemplateCatalogPreview,
} from "./clawhub-preview-content.js";
import {
  CLAWHUB_TIMEOUT_MS,
  assertClawHubDownloadIntegrity,
  readExactTemplateArtifact,
  type TemplateArtifactResponse,
  ClawHubSourceError,
  persistExtractedSource,
  readVerifiedArtifactSource,
  type ResolvedClawHubSource,
} from "./clawhub-source-artifact.js";
import { templateDependencyInventory } from "./dependency-inventory.js";
import {
  clawHubTemplateRef,
  isCanonicalClawHubPackageName,
  isExactSemVer,
} from "./schema-portability.js";

export type { ClawHubTemplateCatalogPreview } from "./clawhub-preview-content.js";
export { ClawHubSourceError };

const CATALOG_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 20;
const MAX_CONTENT_EXCERPT_CHARS = 2048;

function toCatalogExcerpt(content: string | undefined): string {
  return content ? flattenMarkdownToPlainText(content).slice(0, MAX_CONTENT_EXCERPT_CHARS) : "";
}

export type ClawHubCoordinate = { packageName: string; version: string };
export type ClawHubTemplateCatalogEntry = {
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
export type ClawHubTemplateCatalogOverview = {
  featured: ClawHubTemplateCatalogEntry[];
  sections: Array<{ category: string; entries: ClawHubTemplateCatalogEntry[] }>;
};
export type ClawHubTemplateCatalogDetail = ClawHubTemplateCatalogEntry & {
  version: string;
  agentName?: string;
  agentDescription?: string;
  workspaceFiles: number;
  skills: number;
  plugins: number;
  mcpServers: number;
  scheduledJobs: number;
  contents: NonNullable<TemplatesCatalogDetailResult["detail"]["contents"]>;
  scanStatus?: string;
};
type AcceptedTrust = Extract<Awaited<ReturnType<typeof checkClawHubPackageTrust>>, { ok: true }>;
export type ClawHubTemplateTrust = {
  trustWarning?: string;
  riskAcknowledgementRequired: boolean;
  trustRecord: AcceptedTrust["trustInstallRecordFields"];
};

type PublicTemplatePackage = ClawHubPackageListItem & { channel: "official" | "community" };
type OwnedTemplatePackage = PublicTemplatePackage & { ownerHandle: string };

function isPublicTemplatePackage(pkg: unknown): pkg is PublicTemplatePackage {
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
    pkg.family === "template" &&
    ((pkg.channel === "official" && pkg.isOfficial === true) ||
      (pkg.channel === "community" && pkg.isOfficial === false)) &&
    isCanonicalClawHubPackageName(pkg.name)
  );
}

function matchesTemplatePublisher(name: string, ownerHandle: unknown): ownerHandle is string {
  return (
    typeof ownerHandle === "string" &&
    ownerHandle.length > 0 &&
    (!name.startsWith("@") || name.slice(1, name.indexOf("/")) === ownerHandle)
  );
}

function isPublicTemplateListItem(pkg: unknown): pkg is OwnedTemplatePackage {
  return isPublicTemplatePackage(pkg) && matchesTemplatePublisher(pkg.name, pkg.ownerHandle);
}

function requirePublicTemplatePackage(
  detail: ClawHubPackageDetail,
  requestedName: string,
): OwnedTemplatePackage {
  const pkg = detail.package;
  const ownerHandle = detail.owner?.handle;
  if (
    !isPublicTemplatePackage(pkg) ||
    !matchesTemplatePublisher(pkg.name, ownerHandle) ||
    (pkg.name !== requestedName && clawHubTemplateRef(pkg.name, ownerHandle) !== requestedName) ||
    (pkg.ownerHandle !== undefined && pkg.ownerHandle !== null && pkg.ownerHandle !== ownerHandle)
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub returned a different public Template package identity.",
    );
  }
  return { ...pkg, ownerHandle, ownerOfficial: detail.owner?.official === true };
}

function requireTemplateName(packageName: string): void {
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
      "Select an exact published Template version.",
    );
  }
}

function projectCatalogEntry(
  pkg: OwnedTemplatePackage,
  baseUrl?: string,
): ClawHubTemplateCatalogEntry {
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

function projectPublicEntries(
  packages: unknown[],
  baseUrl?: string,
): ClawHubTemplateCatalogEntry[] {
  return packages.filter(isPublicTemplateListItem).map((pkg) => projectCatalogEntry(pkg, baseUrl));
}

function rankByInstalls(
  left: ClawHubTemplateCatalogEntry,
  right: ClawHubTemplateCatalogEntry,
): number {
  return right.installs - left.installs || left.packageName.localeCompare(right.packageName);
}

export async function listClawHubTemplates(
  params: ClawHubFetchOptions & { limit?: number; category?: string; featured?: boolean } = {},
): Promise<ClawHubTemplateCatalogEntry[]> {
  const entries = new Map<string, ClawHubTemplateCatalogEntry>();
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
      family: "template",
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

/** Only an unavailable endpoint or an explicitly incomplete overview uses legacy shelves. */
export async function readClawHubTemplatesOverview(
  params: ClawHubFetchOptions & { limit?: number } = {},
): Promise<ClawHubTemplateCatalogOverview | undefined> {
  const result = await fetchClawHubTemplatesOverview(params);
  if (isJsonObject(result) && result.complete === false) {
    return undefined;
  }
  if (
    !isJsonObject(result) ||
    result.complete !== true ||
    !Array.isArray(result.featured) ||
    !Array.isArray(result.sections) ||
    !result.sections.every(
      (section) =>
        isJsonObject(section) &&
        typeof section.category === "string" &&
        Array.isArray(section.items),
    )
  ) {
    throw new ClawHubSourceError(
      "clawhub_catalog_invalid",
      "ClawHub returned a malformed Template overview.",
    );
  }
  const limit = params.limit ?? 8;
  return {
    featured: projectPublicEntries(result.featured, params.baseUrl).slice(0, limit),
    sections: result.sections.map((section) => ({
      category: section.category,
      entries: projectPublicEntries(section.items, params.baseUrl)
        .toSorted(rankByInstalls)
        .slice(0, limit),
    })),
  };
}

export async function searchClawHubTemplates(
  params: ClawHubFetchOptions & { query: string; limit?: number; category?: string },
): Promise<ClawHubTemplateCatalogEntry[]> {
  const query = params.query.trim();
  if (!query) {
    return await listClawHubTemplates(params);
  }
  const results = await searchClawHubPackages({
    ...params,
    query,
    family: "template",
    category: params.category,
    limit: params.limit ?? CATALOG_PAGE_SIZE,
  });
  const entries = projectPublicEntries(
    results.map((result) => result.package),
    params.baseUrl,
  );
  return params.category ? entries.toSorted(rankByInstalls) : entries;
}

export async function readClawHubTemplateDetail(
  params: ClawHubFetchOptions & { packageName: string; version?: string },
): Promise<ClawHubTemplateCatalogDetail> {
  requireTemplateName(params.packageName);
  if (params.version !== undefined) {
    requireExactVersion(params.version);
  }
  const packagePromise = fetchClawHubPackageDetail({ ...params, name: params.packageName }).then(
    (detail) => requirePublicTemplatePackage(detail, params.packageName),
  );
  const versionPromise =
    params.version !== undefined
      ? Promise.resolve(params.version)
      : packagePromise.then((pkg) => {
          if (!pkg.latestVersion) {
            throw new ClawHubSourceError(
              "clawhub_version_unavailable",
              "ClawHub has no published version.",
            );
          }
          requireExactVersion(pkg.latestVersion);
          return pkg.latestVersion;
        });
  const releasePromise = versionPromise.then((version) =>
    fetchClawHubPackageVersion({ ...params, name: params.packageName, version }),
  );
  // Each endpoint enforces current visibility. Fetch exact-release data concurrently,
  // but consume archive bytes only after checking every identity.
  const downloadAbort = new AbortController();
  const downloadPromise = versionPromise.then((version) =>
    downloadClawHubPackageArchive({
      ...params,
      signal: params.signal
        ? AbortSignal.any([params.signal, downloadAbort.signal])
        : downloadAbort.signal,
      name: params.packageName,
      version,
      artifact: "clawpack",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
    }),
  );
  try {
    const [pkg, release, download, version] = await Promise.all([
      packagePromise,
      releasePromise,
      downloadPromise,
      versionPromise,
    ]);
    if (release.package?.name !== pkg.name || release.package.family !== "template") {
      throw new ClawHubSourceError(
        "clawhub_identity_mismatch",
        "ClawHub release identity changed.",
      );
    }
    if (!release.version || release.version.version !== version) {
      throw new ClawHubSourceError(
        "clawhub_version_unavailable",
        "ClawHub release identity changed.",
      );
    }
    const summary = parseTemplateManifestSummary(release.version.templateManifestSummary);
    const { contents } = await readClawHubTemplateContents(
      {
        ...params,
        packageName: pkg.name,
        version,
      },
      undefined,
      {
        download,
        artifact: { package: release.package, version, artifact: release.version.artifact },
      },
    );
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
  } catch (error) {
    downloadAbort.abort(error);
    throw error;
  } finally {
    // Metadata can fail while the parallel download succeeds; always release it.
    await downloadPromise.then(
      (download) => download.cleanup(),
      () => undefined,
    );
  }
}

export async function readClawHubTemplatePreview(
  params: ClawHubFetchOptions &
    ClawHubCoordinate & {
      kind: ClawHubTemplateCatalogPreview["kind"];
      name: string;
    },
): Promise<ClawHubTemplateCatalogPreview> {
  requireTemplateName(params.packageName);
  requireExactVersion(params.version);
  const detail = await fetchClawHubPackageDetail({ ...params, name: params.packageName });
  requirePublicTemplatePackage(detail, params.packageName);
  const { preview } = await readClawHubTemplateContents(params, {
    kind: params.kind,
    name: params.name,
  });
  if (!preview) {
    throw new ClawHubSourceError(
      "clawhub_preview_unavailable",
      "This item is not in the Template release.",
    );
  }
  return preview;
}

async function readClawHubTemplateContents(
  params: ClawHubFetchOptions & ClawHubCoordinate,
  requestedPreview?: Pick<ClawHubTemplateCatalogPreview, "kind" | "name">,
  prepared?: {
    download: ClawHubDownloadResult;
    artifact: TemplateArtifactResponse;
  },
): Promise<{
  contents: ClawHubTemplateCatalogDetail["contents"];
  preview?: ClawHubTemplateCatalogPreview;
}> {
  const artifactResponse =
    prepared?.artifact ??
    (await fetchClawHubPackageArtifact({
      ...params,
      name: params.packageName,
    }));
  const expected = readExactTemplateArtifact(artifactResponse, params);
  const download =
    prepared?.download ??
    (await downloadClawHubPackageArchive({
      name: params.packageName,
      version: params.version,
      artifact: "clawpack",
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params.token ? { token: params.token } : {}),
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
    }));
  try {
    assertClawHubDownloadIntegrity(download, expected);
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-template-catalog-",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md"],
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
        if (
          verified.templateMarkdownBody &&
          !instructions.some((file) => file.name === "SOUL.md")
        ) {
          instructions.push({ name: "SOUL.md", source: "CLAW.md#body" });
        }
        const { skills, integrations } = projectTemplateCatalogDependencies(
          manifest,
          verified.snapshot.bundledSources,
        );
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
              integrations,
              automations: manifest.automations.map((job) => ({
                name: job.name || job.id,
                enabled: job.enabled ?? true,
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
    if (!prepared) {
      await download.cleanup();
    }
  }
}

type PersistClawHubSource = () => Promise<ResolvedClawHubSource>;

export async function withResolvedClawHubSource<T>(
  params: ClawHubFetchOptions & {
    coordinate: { packageName: string; version?: string };
    mode: "preview" | "apply";
    acknowledgeClawHubRisk?: boolean;
    stateDir?: string;
    run: (
      source: ResolvedClawHubSource,
      trust: ClawHubTemplateTrust,
      persistSource: PersistClawHubSource,
    ) => Promise<T>;
  },
): Promise<{ value: T } & ClawHubTemplateTrust> {
  const requestedName = params.coordinate.packageName;
  requireTemplateName(requestedName);
  if (params.coordinate.version !== undefined) {
    requireExactVersion(params.coordinate.version);
  }
  // Exact releases can fetch independent metadata together; latest needs the catalog version first.
  const [detail, exactArtifact] = await Promise.all([
    fetchClawHubPackageDetail({ ...params, name: requestedName }),
    params.coordinate.version === undefined
      ? Promise.resolve(undefined)
      : fetchClawHubPackageArtifact({
          ...params,
          name: requestedName,
          version: params.coordinate.version,
        }),
  ]);
  // `@publisher/slug` may name an unscoped package; exact-release identity, trust
  // and archive checks all bind to the stored name.
  const pkg = requirePublicTemplatePackage(detail, requestedName);
  const packageName = pkg.name;
  const version = params.coordinate.version ?? pkg.latestVersion;
  if (!version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub has no published version.",
    );
  }
  requireExactVersion(version);
  const artifact =
    exactArtifact ?? (await fetchClawHubPackageArtifact({ ...params, name: packageName, version }));
  const resolvedArtifact = readExactTemplateArtifact(artifact, { packageName, version });
  const expectedSha256 = resolvedArtifact.sha256;
  const trust = await checkClawHubPackageTrust({
    subject: { kind: "template", packageName },
    version,
    expectedTemplateArtifact: {
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
  const trustProjection: ClawHubTemplateTrust = {
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
    assertClawHubDownloadIntegrity(download, resolvedArtifact);
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-template-source-",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md"],
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
          templateDependencyInventory(artifactSource.manifest).length > 0
        ) {
          throw new ClawHubSourceError(
            "clawhub_registry_mismatch",
            "ClawHub Template dependencies require the configured registry.",
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
