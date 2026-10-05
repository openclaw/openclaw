import type { SkillsDetailResult } from "@openclaw/gateway-protocol";
// ClawHub skill metadata, trust, install resolution, cards, and telemetry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ClawHubRequestError,
  createClawHubError,
  decodeClawHubResponseBody,
  fetchClawHubJson,
  parseClawHubJsonBody,
  readClawHubBytes,
  withClawHubResponse,
  resolveClawHubBaseUrl,
  resolveClawHubImageUrl,
  type ClawHubFetchOptions,
} from "./clawhub-client.js";
import { reportClawHubInstallTelemetry } from "./clawhub-telemetry.js";

const SKILL_CARD_MAX_BYTES = 256 * 1024;
// Full scanner evidence can exceed the metadata reader's 16 MiB cap.
const SKILL_VERIFICATION_MAX_BYTES = 64 * 1024 * 1024;

export const CLAWHUB_SKILLS_SH_TRUST_STATE = "not-scanned-by-clawhub" as const;
export const CLAWHUB_SKILLS_SH_TRUST_LABEL = "Not scanned by ClawHub" as const;
/** Marks a reference ClawHub resolves from an external source it never scanned. */
export const CLAWHUB_SKILLS_SH_REF_PREFIX = "skills-sh:" as const;
export type ClawHubSkillsShTrustState = typeof CLAWHUB_SKILLS_SH_TRUST_STATE;

export type ClawHubSkillSearchResult = {
  score: number;
  slug: string;
  registry: string;
  /**
   * Reference install must send back. Search returns the same slug for several publishers, so
   * the bare slug alone resolves to 409 AMBIGUOUS_SKILL_SLUG. This names the result's own
   * source: rewriting an external reference into `@owner/slug` would install a different skill.
   */
  installRef: string;
  /**
   * Set only for sources ClawHub serves install-only, so clients install directly instead of
   * opening a detail card that cannot resolve. Absence means the ordinary review-then-install
   * flow, which is what every released Gateway already implies by omitting this field.
   */
  installOnly?: true;
  trustState?: ClawHubSkillsShTrustState;
  // Search may return the same slug for multiple publishers; exact install refs need this handle.
  ownerHandle?: string | null;
  /** Official status comes from ClawHub's canonical search result, never the handle. */
  official?: boolean;
  displayName: string;
  summary?: string;
  icon?: string | null;
  version?: string;
  updatedAt?: number;
};

/** Source variants ClawHub resolves search results from. Anything else is unidentifiable. */
const CLAWHUB_NATIVE_SOURCE_KIND = "clawhub";
const CLAWHUB_SKILLS_SH_SOURCE_KIND = "skills-sh";
const CLAWHUB_SUPPORTED_INSTALL_KINDS = new Set(["clawhub", "github", "skills-sh"]);

/**
 * Wire shape of one `/api/v1/search` row. ClawHub reports each result's origin under `install`,
 * never as a flat `installRef`, so the mapping below is what keeps search identity honest.
 */
type ClawHubSkillSearchWireEntry = Omit<
  ClawHubSkillSearchResult,
  "registry" | "installRef" | "installOnly" | "trustState"
> & {
  source?: string | null;
  install?: { kind?: string | null; reference?: string | null } | null;
};

type ClawHubSkillTrendingWireEntry = Pick<
  ClawHubSkillSearchWireEntry,
  "slug" | "displayName" | "source" | "install" | "official"
> & {
  summary?: string | null;
  publisher?: { handle?: string | null } | null;
  metrics?: { updatedAt?: number | null };
};

export type ClawHubSkillDetail = SkillsDetailResult;

export type ClawHubSkillInstallResolutionResponse =
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "archive";
      archive: {
        version: string;
        downloadUrl: string;
        channel?: string | null;
        isOfficial?: boolean | null;
      };
    }
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "github";
      trust?: {
        state: ClawHubSkillsShTrustState;
      };
      /** Commit-pinned source approved by ClawHub's install resolver policy. */
      github: {
        repo: string;
        path: string;
        commit: string;
        contentHash: string;
        sourceUrl: string;
      };
    }
  | {
      ok: false;
      slug: string;
      reason: string;
      message: string;
      status: number;
    };

type ClawHubSkillVerificationDecision = "pass" | "fail" | (string & {});

export type ClawHubSkillVerificationResponse = {
  schema: "clawhub.skill.verify.v1";
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  slug?: string | null;
  displayName?: string | null;
  pageUrl?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  skill: unknown;
  publisher: unknown;
  version: unknown;
  card: unknown;
  artifact: unknown;
  provenance: unknown;
  security: unknown;
  signature: unknown;
};

type ClawHubSkillSecurityVerdictRequestItem = {
  slug: string;
  ownerHandle?: string;
  version: string;
};

export type ClawHubSkillSecurityVerdictItem = {
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  requestedSlug: string;
  requestedOwnerHandle?: string;
  requestedVersion: string;
  slug?: string | null;
  version?: string | null;
  displayName?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  checkedAt?: number | null;
  skillUrl?: string | null;
  overview?: string | null;
  securityAuditUrl?: string | null;
  security?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type ClawHubSkillSecurityVerdictsResponse = {
  schema: "clawhub.skill.security-verdicts.v1";
  items: ClawHubSkillSecurityVerdictItem[];
};

function buildVersionOrTagSearch(params: {
  version?: string;
  tag?: string;
  ownerHandle?: string;
}): { version?: string; tag?: string; ownerHandle?: string } | undefined {
  const version = normalizeOptionalString(params.version);
  const ownerHandle = normalizeOptionalString(params.ownerHandle);
  if (version) {
    return { version, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  const tag = normalizeOptionalString(params.tag);
  if (tag) {
    return { tag, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  return ownerHandle ? { ownerHandle } : undefined;
}

export async function searchClawHubSkills(
  params: ClawHubFetchOptions & {
    query: string;
    limit?: number;
  },
): Promise<ClawHubSkillSearchResult[]> {
  const registry = resolveClawHubBaseUrl(params.baseUrl);
  const query = params.query.trim();
  const request = {
    ...params,
    baseUrl: registry,
  };
  let entries: ClawHubSkillSearchWireEntry[];
  if (query) {
    const result = await fetchClawHubJson<{ results: ClawHubSkillSearchWireEntry[] }>({
      ...request,
      path: "/api/v1/search",
      search: { q: query, limit: params.limit ? String(params.limit) : undefined },
    });
    entries = result.results ?? [];
  } else {
    const result = await fetchClawHubJson<{ items: ClawHubSkillTrendingWireEntry[] }>({
      ...request,
      path: "/api/v1/trending",
      search: { kind: "skills", limit: String(Math.min(params.limit ?? 20, 100)) },
    });
    // Trending owns ordering and publisher identity; the plain skills list has no publisher.
    // Both feeds enter the same source-qualified mapping before detail or install is offered.
    entries = (result.items ?? []).map((entry) => ({
      score: 0,
      slug: entry.slug,
      displayName: entry.displayName,
      summary: entry.summary ?? undefined,
      source: entry.source,
      install: entry.install,
      official: entry.official,
      ownerHandle: entry.publisher?.handle,
      updatedAt: entry.metrics?.updatedAt ?? undefined,
    }));
  }
  return entries.flatMap((entry) => {
    const mapped = toClawHubSkillSearchResult(entry, registry);
    return mapped ? [mapped] : [];
  });
}

/**
 * Records each result's own source once, here, so no consumer rebuilds it. A row whose source is
 * unknown, or whose external reference is missing, is dropped rather than published under
 * `@owner/slug`: that spelling would point install at a different publisher's skill.
 */
function toClawHubSkillSearchResult(
  entry: ClawHubSkillSearchWireEntry,
  registry: string,
): ClawHubSkillSearchResult | undefined {
  const { install: _install, source: _source, ...rest } = entry;
  const base = { ...rest, registry, icon: resolveClawHubImageUrl(entry.icon, registry) };
  const source = normalizeOptionalString(entry.source);
  const installKind = normalizeOptionalString(entry.install?.kind);
  const reference = normalizeOptionalString(entry.install?.reference);
  // Source identifies the catalog row. Install kind only describes how ClawHub will deliver it:
  // native ClawHub rows may legitimately be GitHub-backed.
  if (installKind && !CLAWHUB_SUPPORTED_INSTALL_KINDS.has(installKind)) {
    return undefined;
  }
  switch (source) {
    case CLAWHUB_SKILLS_SH_SOURCE_KIND: {
      // An external row is only installable as itself. Without its own reference there is no
      // identity to install, so the row cannot be offered at all.
      if (!reference?.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX)) {
        return undefined;
      }
      return {
        ...base,
        installRef: reference,
        installOnly: true,
        trustState: CLAWHUB_SKILLS_SH_TRUST_STATE,
      };
    }
    case CLAWHUB_NATIVE_SOURCE_KIND: {
      // Native rows report `owner/slug`; this repo's reference grammar is `@owner/slug`. Without
      // a publisher the bare slug answers 409 AMBIGUOUS_SKILL_SLUG for every action.
      const ownerHandle = normalizeOptionalString(entry.ownerHandle);
      return ownerHandle ? { ...base, installRef: `@${ownerHandle}/${entry.slug}` } : undefined;
    }
    default:
      return undefined;
  }
}

type ClawHubSkillVersionDetail = {
  version: {
    version: string;
    createdAt: number;
    changelog?: string;
    security?: {
      status: string;
      hasWarnings: boolean;
      hasScanResult: boolean;
      checkedAt?: number | null;
      virustotalUrl?: string | null;
      scanners?: { llm?: { summary?: string | null } | null };
    } | null;
  };
};

export async function fetchClawHubSkillDetail(
  params: ClawHubFetchOptions & {
    slug: string;
    ownerHandle?: string;
    version?: string;
    /** Interactive detail reads include card and release scans; install resolution needs metadata only. */
    includeInspection?: boolean;
  },
): Promise<ClawHubSkillDetail> {
  const registry = resolveClawHubBaseUrl(params.baseUrl);
  const detail = await fetchClawHubJson<ClawHubSkillDetail>({
    ...params,
    baseUrl: registry,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
    search: params.ownerHandle ? { ownerHandle: params.ownerHandle } : undefined,
  });
  if (detail.skill && detail.skill.slug !== params.slug) {
    throw new Error("ClawHub returned details for a different skill.");
  }
  if (params.ownerHandle && detail.owner?.handle && detail.owner.handle !== params.ownerHandle) {
    throw new Error("ClawHub returned details for a different publisher.");
  }
  if (!params.includeInspection && params.version === undefined) {
    return {
      ...detail,
      skill: detail.skill
        ? { ...detail.skill, icon: resolveClawHubImageUrl(detail.skill.icon, registry) }
        : null,
    };
  }
  const ownerHandle = params.ownerHandle ?? detail.owner?.handle ?? undefined;
  const version = normalizeOptionalString(params.version) ?? detail.latestVersion?.version;
  const request = { ...params, baseUrl: registry, ownerHandle, version };
  const warnings: string[] = [];
  // The version endpoint is the owner of release-specific security. Base metadata only
  // describes latest, so it must never be relabeled as requirements for an older release.
  const [release, card] = version
    ? await Promise.allSettled([
        fetchClawHubJson<ClawHubSkillVersionDetail>({
          ...request,
          path: `/api/v1/skills/${encodeURIComponent(params.slug)}/versions/${encodeURIComponent(version)}`,
          search: ownerHandle ? { ownerHandle } : undefined,
        }),
        fetchClawHubSkillCard(request),
      ])
    : [];
  if (release?.status === "rejected") {
    warnings.push(`Selected release details unavailable: ${String(release.reason)}`);
  }
  const returnedVersion = release?.status === "fulfilled" ? release.value.version : undefined;
  const selectedVersion = returnedVersion?.version === version ? returnedVersion : undefined;
  const releaseMismatch = release?.status === "fulfilled" && selectedVersion === undefined;
  if (releaseMismatch) {
    warnings.push("ClawHub returned details for a different release.");
  }
  const releaseUnavailable =
    release?.status === "rejected" &&
    release.reason instanceof ClawHubRequestError &&
    [404, 410].includes(release.reason.status);
  const security = selectedVersion?.security;
  const validSecurity =
    security &&
    typeof security.status === "string" &&
    security.status.trim().length > 0 &&
    typeof security.hasWarnings === "boolean" &&
    typeof security.hasScanResult === "boolean";
  const isLatest = version !== undefined && version === detail.latestVersion?.version;
  const canUseLatest = isLatest && !releaseUnavailable && !releaseMismatch;
  return {
    ...detail,
    registry,
    source: "clawhub",
    installRef: ownerHandle ? `@${ownerHandle}/${params.slug}` : params.slug,
    selectedRelease: selectedVersion
      ? {
          version: selectedVersion.version,
          createdAt: selectedVersion.createdAt,
          changelog: selectedVersion.changelog,
          tags: Object.entries(detail.skill?.tags ?? {})
            .filter(([, taggedVersion]) => taggedVersion === selectedVersion.version)
            .map(([tag]) => tag),
        }
      : canUseLatest && detail.latestVersion
        ? {
            version: detail.latestVersion.version,
            createdAt: detail.latestVersion.createdAt,
            changelog: detail.latestVersion.changelog,
          }
        : null,
    // Neither listing visibility, successful card reads, nor scan verdicts assert that
    // this exact release has a downloadable artifact. ClawHub's install resolver picks latest.
    downloadability: !version
      ? {
          status: "unknown",
          reason: "The listing has no hosted release; source-backed availability is not reported.",
        }
      : releaseUnavailable
        ? { status: "unavailable", reason: "The selected release is not available from ClawHub." }
        : {
            status: "unknown",
            reason:
              release?.status === "rejected"
                ? `Selected release details unavailable: ${String(release.reason)}`
                : releaseMismatch
                  ? "ClawHub returned details for a different release."
                  : "ClawHub does not report downloadability for a selected skill release.",
          },
    card:
      card?.status === "fulfilled"
        ? { status: "available", content: card.value }
        : {
            status: "unavailable",
            reason:
              card?.status === "rejected"
                ? String(card.reason)
                : "No published release is available for a skill card.",
          },
    requirements:
      canUseLatest && detail.metadata?.setup
        ? {
            status: "available",
            setup: detail.metadata.setup,
            os: detail.metadata.os,
            systems: detail.metadata.systems,
            scope: "registry-setup",
            note: "Registry setup keys combine environment and configuration requirements; binary requirements are not reported.",
          }
        : {
            status: "unavailable",
            reason: isLatest
              ? "ClawHub does not report setup requirements for this release."
              : "ClawHub reports structured setup requirements only for the latest release.",
          },
    security: validSecurity
      ? {
          status: "available",
          scanStatus: security.status,
          hasWarnings: security.hasWarnings,
          hasScanResult: security.hasScanResult,
          checkedAt: typeof security.checkedAt === "number" ? security.checkedAt : null,
          summary:
            typeof security.scanners?.llm?.summary === "string"
              ? security.scanners.llm.summary
              : null,
          virustotalUrl: typeof security.virustotalUrl === "string" ? security.virustotalUrl : null,
        }
      : {
          status: "unavailable",
          reason: "ClawHub has no security scan snapshot for this release.",
        },
    warnings,
    skill: detail.skill
      ? { ...detail.skill, icon: resolveClawHubImageUrl(detail.skill.icon, registry) }
      : null,
    owner: detail.owner
      ? { ...detail.owner, image: resolveClawHubImageUrl(detail.owner.image, registry) }
      : detail.owner,
  };
}

export async function fetchClawHubSkillInstallResolution(
  params: ClawHubFetchOptions & {
    slug: string;
    ownerHandle?: string;
    requestedReference?: string;
    forceInstall?: boolean;
  },
): Promise<ClawHubSkillInstallResolutionResponse> {
  return await withClawHubResponse(
    {
      ...params,
      path: `/api/v1/skills/${encodeURIComponent(params.slug)}/install`,
      search: {
        ownerHandle: params.ownerHandle,
        reference: params.requestedReference,
        forceInstall: params.forceInstall ? "1" : undefined,
      },
    },
    async ({ response, url, hasToken }) => {
      const isStructuredBlock = [403, 409, 410, 423].includes(response.status);
      if (!response.ok && !isStructuredBlock) {
        throw await createClawHubError(response, url, hasToken, params.timeoutMs);
      }
      return parseClawHubJsonBody<ClawHubSkillInstallResolutionResponse>(
        response,
        url,
        params.timeoutMs,
      );
    },
  );
}

export async function fetchClawHubSkillVerification(
  params: ClawHubFetchOptions & {
    slug: string;
    ownerHandle?: string;
    requestedReference?: string;
    version?: string;
    tag?: string;
    skipAuth?: boolean;
  },
): Promise<ClawHubSkillVerificationResponse> {
  return await fetchClawHubJson<ClawHubSkillVerificationResponse>({
    ...params,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}/verify`,
    maxResponseBytes: SKILL_VERIFICATION_MAX_BYTES,
    search: {
      ...buildVersionOrTagSearch(params),
      reference: params.requestedReference,
    },
  });
}

export async function fetchClawHubSkillSecurityVerdicts(
  params: ClawHubFetchOptions & {
    items: ClawHubSkillSecurityVerdictRequestItem[];
    skipAuth?: boolean;
  },
): Promise<ClawHubSkillSecurityVerdictsResponse> {
  return await fetchClawHubJson<ClawHubSkillSecurityVerdictsResponse>({
    ...params,
    path: "/api/v1/skills/-/security-verdicts",
    method: "POST",
    json: { items: params.items },
  });
}

export async function fetchClawHubSkillCard(
  params: ClawHubFetchOptions & {
    slug?: string;
    ownerHandle?: string;
    url?: string;
    version?: string;
    tag?: string;
  },
): Promise<string> {
  const cardUrl = normalizeOptionalString(params.url);
  const slug = normalizeOptionalString(params.slug);
  if (!cardUrl && !slug) {
    throw new Error("ClawHub skill card fetch requires a slug or card URL");
  }
  const providedToken = normalizeOptionalString(params.token);
  const skipAuth =
    cardUrl != null &&
    providedToken == null &&
    new URL(cardUrl, `${resolveClawHubBaseUrl(params.baseUrl)}/`).origin !==
      new URL(`${resolveClawHubBaseUrl(params.baseUrl)}/`).origin;
  return await withClawHubResponse(
    {
      ...params,
      url: cardUrl,
      path: slug ? `/api/v1/skills/${encodeURIComponent(slug)}/card` : undefined,
      token: providedToken,
      search: cardUrl ? undefined : buildVersionOrTagSearch(params),
      skipAuth,
    },
    async ({ response, url, hasToken }) => {
      if (!response.ok) {
        throw await createClawHubError(response, url, hasToken, params.timeoutMs);
      }
      const bytes = await readClawHubBytes({
        response,
        maxBytes: SKILL_CARD_MAX_BYTES,
        timeoutMs: params.timeoutMs,
        resourceLabel: slug ? `skill card for ${slug}` : `skill card at ${url.pathname}`,
      });
      return decodeClawHubResponseBody(bytes);
    },
  );
}

export async function reportClawHubSkillInstallTelemetry(
  params: ClawHubFetchOptions & {
    slug: string;
    ownerHandle?: string;
    requestedReference?: string;
    trustState?: ClawHubSkillsShTrustState;
    version?: string | null;
  },
): Promise<void> {
  return await reportClawHubInstallTelemetry(params, () => {
    const slug = params.slug.trim();
    return slug
      ? {
          event: "install",
          slug,
          ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
          ...(params.requestedReference ? { reference: params.requestedReference } : {}),
          ...(params.trustState ? { trustState: params.trustState } : {}),
          version: params.version ?? undefined,
        }
      : undefined;
  });
}
