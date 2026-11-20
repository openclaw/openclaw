// ClawHub discovery and exact-artifact resolution for public Templates.
import fs from "node:fs/promises";
import {
  downloadClawHubPackageArchive,
  type ClawHubDownloadResult,
} from "../infra/clawhub-artifacts.js";
import { resolveClawHubBaseUrl, type ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { checkClawHubPackageTrust } from "../infra/clawhub-install-trust.js";
import {
  fetchClawHubPackageArtifact,
  fetchClawHubPackageDetail,
  fetchClawHubPackageSecurity,
  fetchClawHubPackageVersion,
  type ClawHubPackageSecurityResponse,
} from "../infra/clawhub-packages.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { projectTemplateCatalogDependencies } from "./catalog-dependencies.js";
import type { ClawHubTemplateCatalogDetail } from "./clawhub-catalog-types.js";
import { projectCatalogEntry, requirePublicTemplatePackage } from "./clawhub-catalog.js";
import {
  countTemplateContents,
  readTemplateDisplayInventory,
} from "./clawhub-display-inventory.js";
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
  requireTemplateName,
  requireExactVersion,
  type ResolvedClawHubSource,
} from "./clawhub-source-artifact.js";
import { templateDependencyInventory } from "./dependency-inventory.js";
import { measureTemplateAddStage, startTemplateAddStage } from "./timings.js";

export type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
} from "./clawhub-catalog-types.js";
export type { ClawHubTemplateCatalogPreview } from "./clawhub-preview-content.js";
export { ClawHubSourceError };

export { readClawHubTemplatesOverview, searchClawHubTemplates } from "./clawhub-catalog.js";

export type ClawHubCoordinate = { packageName: string; version: string };
type AcceptedTrust = Extract<Awaited<ReturnType<typeof checkClawHubPackageTrust>>, { ok: true }>;
export type ClawHubTemplateTrust = {
  trustWarning?: string;
  riskAcknowledgementRequired: boolean;
  trustRecord: AcceptedTrust["trustInstallRecordFields"];
};

// Retain only names/coordinates from verified public archives; never file bodies, audit, or access decisions.
const verifiedDetailContents = new Map<
  string,
  {
    artifact: ReturnType<typeof readExactTemplateArtifact>;
    contents: ClawHubTemplateCatalogDetail["contents"];
  }
>();

export async function readClawHubTemplateDetail(
  params: ClawHubFetchOptions & { packageName: string; version?: string },
): Promise<ClawHubTemplateCatalogDetail> {
  requireTemplateName(params.packageName);
  if (params.version !== undefined) {
    requireExactVersion(params.version);
  }
  // A missing expansion means an older registry. A refusal or malformed present
  // expansion is authoritative: never bypass it by requesting archive bytes.
  const detail = await fetchClawHubPackageDetail({
    ...params,
    name: params.packageName,
    view: "template-inventory",
  });
  const pkg = requirePublicTemplatePackage(detail, params.packageName);
  const version = params.version ?? pkg.latestVersion;
  if (!version) {
    throw new ClawHubSourceError(
      "clawhub_version_unavailable",
      "ClawHub has no published version.",
    );
  }
  requireExactVersion(version);
  const coordinate = { packageName: pkg.name, version };
  if (Object.hasOwn(detail, "templateInventory")) {
    const inventory = readTemplateDisplayInventory(
      detail.templateInventory,
      coordinate,
      version === pkg.latestVersion ? [pkg.artifact, pkg.clawpack] : [],
    );
    return projectDetail(pkg, version, inventory, params.baseUrl);
  }
  // Only a verified legacy read may populate or reuse the legacy contents cache.
  const releasePromise = fetchClawHubPackageVersion({ ...params, name: pkg.name, version });
  const securityPromise = fetchClawHubPackageSecurity({ ...params, name: pkg.name, version }).catch(
    () => undefined,
  );
  const registry = resolveClawHubBaseUrl(params.baseUrl);
  const abort = new AbortController();
  const fetchArchive = () =>
    downloadClawHubPackageArchive({
      ...params,
      name: pkg.name,
      version,
      artifact: "clawpack",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      signal: params.signal ? AbortSignal.any([params.signal, abort.signal]) : abort.signal,
    });
  const key = JSON.stringify([registry, pkg.name, version]);
  let download: Promise<ClawHubDownloadResult> | undefined = verifiedDetailContents.has(key)
    ? undefined
    : fetchArchive();
  try {
    const [release, cold] = await Promise.all([releasePromise, download]);
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
    const artifact = { package: release.package, version, artifact: release.version.artifact };
    const expected = readExactTemplateArtifact(artifact, coordinate);
    const summary = parseTemplateManifestSummary(release.version.templateManifestSummary);
    const readContents = async () => {
      const cached = !cold && verifiedDetailContents.get(key);
      if (
        cached &&
        cached.artifact.sha256 === expected.sha256 &&
        cached.artifact.npmIntegrity === expected.npmIntegrity &&
        cached.artifact.npmShasum === expected.npmShasum
      ) {
        const security = await securityPromise;
        if (
          security?.package?.name === pkg.name &&
          security.package.family === "template" &&
          security.release?.version === version &&
          security.release.artifactKind === "npm-pack" &&
          security.release.artifactSha256 === expected.sha256 &&
          (expected.npmShasum === undefined || security.release.npmShasum === expected.npmShasum) &&
          security.release.npmIntegrity === expected.npmIntegrity &&
          // The security client requires this boolean; incomplete responses reject.
          !security.trust.blockedFromDownload
        ) {
          return cached.contents;
        }
      }
      download ??= fetchArchive();
      const { contents } = await readClawHubTemplateContents(
        { ...params, ...coordinate },
        undefined,
        { artifact, download: await download },
      );
      verifiedDetailContents.delete(key);
      verifiedDetailContents.set(key, {
        artifact: expected,
        contents,
      });
      if (verifiedDetailContents.size > 32) {
        verifiedDetailContents.delete(verifiedDetailContents.keys().next().value!);
      }
      return contents;
    };
    const [contents, security] = await Promise.all([readContents(), securityPromise]);
    return projectDetail(
      pkg,
      version,
      { contents, security, summary, icon: release.version.icon },
      params.baseUrl,
    );
  } catch (error) {
    abort.abort(error);
    throw error;
  } finally {
    await download?.then(
      (result) => result.cleanup(),
      () => undefined,
    );
  }
}

function projectDetail(
  pkg: ReturnType<typeof requirePublicTemplatePackage>,
  version: string,
  data: {
    contents: ClawHubTemplateCatalogDetail["contents"];
    summary: ReturnType<typeof parseTemplateManifestSummary>;
    security?: ClawHubPackageSecurityResponse;
    icon?: string | null;
  },
  baseUrl?: string,
): ClawHubTemplateCatalogDetail {
  const { contents, summary, security, icon } = data;
  const categories = Array.isArray(pkg.categories)
    ? pkg.categories.filter((category) => typeof category === "string" && category.length > 0)
    : [];
  return {
    ...projectCatalogEntry({ ...pkg, icon }, baseUrl),
    version,
    agentId: summary.id,
    ...(summary.name ? { agentName: summary.name } : {}),
    ...(summary.description ? { agentDescription: summary.description } : {}),
    ...countTemplateContents(contents),
    contents,
    ...(Number.isFinite(pkg.createdAt) ? { createdAtMs: Math.max(0, pkg.createdAt) } : {}),
    ...(categories.length ? { categories } : {}),
    ...(security?.package?.name === pkg.name && security.release?.version === version
      ? {
          security: {
            ...(security.verdict ? { verdict: security.verdict } : {}),
            auditUrl: security.securityAuditUrl,
          },
        }
      : {}),
  };
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
  // `@publisher/slug` may name an unscoped package; the artifact binds to the stored name.
  const pkg = requirePublicTemplatePackage(detail, params.packageName);
  const { preview } = await readClawHubTemplateContents(
    { ...params, packageName: pkg.name },
    { kind: params.kind, name: params.name },
  );
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
              instructions,
              skills,
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
  const [detail, exactArtifact] = await measureTemplateAddStage("source.metadata", () =>
    Promise.all([
      measureTemplateAddStage("source.metadata.detail", () =>
        fetchClawHubPackageDetail({ ...params, name: requestedName }),
      ),
      params.coordinate.version === undefined
        ? Promise.resolve(undefined)
        : fetchClawHubPackageArtifact({
            ...params,
            name: requestedName,
            version: params.coordinate.version,
          }),
    ]),
  );

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
  const trust = await measureTemplateAddStage("source.trust", () =>
    checkClawHubPackageTrust({
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
    }),
  );
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

  const download = await measureTemplateAddStage("source.download", () =>
    downloadClawHubPackageArchive({
      name: packageName,
      version,
      artifact: "clawpack",
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
    }),
  );
  try {
    assertClawHubDownloadIntegrity(download, resolvedArtifact);
    const artifactByteLength = (await fs.stat(download.archivePath)).size;
    using extraction = startTemplateAddStage("source.extract");
    const extracted = await withExtractedArchiveRoot({
      archivePath: download.archivePath,
      tempDirPrefix: "openclaw-template-source-",
      timeoutMs: params.timeoutMs ?? CLAWHUB_TIMEOUT_MS,
      rootMarkers: ["package.json", "CLAW.md"],
      onExtracted: async (rootDir) => {
        extraction.end("ok");
        const artifactSource = await measureTemplateAddStage("source.verify", () =>
          readVerifiedArtifactSource({
            sourceRoot: rootDir,
            packageName,
            version,
            artifactSha256: expectedSha256,
            artifactByteLength,
          }),
        );
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
            const sourceRoot = await measureTemplateAddStage("source.persist", () =>
              persistExtractedSource({
                rootDir,
                archivePath: download.archivePath,
                artifactSha256: expectedSha256,
                artifactByteLength,
                stateDir: params.stateDir,
              }),
            );
            return await measureTemplateAddStage("source.verify", () =>
              readVerifiedArtifactSource({
                sourceRoot,
                packageName,
                version,
                artifactSha256: expectedSha256,
                artifactByteLength,
              }),
            );
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
