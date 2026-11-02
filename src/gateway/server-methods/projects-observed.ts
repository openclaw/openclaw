import {
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
  type ProjectRecord,
  type ProjectSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { loadCombinedSessionStoreForGatewayCoreAsync } from "../../config/sessions/combined-store-gateway-read.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import type { startProjectsListDiagnostics } from "./projects-list-diagnostics.js";
import { ProjectListingChangedError } from "./projects-session-store.js";
import type { GatewayRequestHandlers } from "./types.js";

type ProjectCandidate = {
  checkoutPath: string;
  fingerprint: string;
  lastUsedAt: number;
  originUrl?: string;
};

type RawProjectCandidate =
  | { kind: "session"; checkoutPath: string; lastUsedAt: number; sessionKey: string }
  | {
      kind: "worktree";
      checkoutPath: string;
      fingerprint: string;
      lastUsedAt: number;
      repoRoot: string;
      sessionKey?: string;
    };

type ProjectGroup = {
  checkouts: Map<string, { path: string; lastUsedAt: number }>;
  lastUsedAt: number;
  name: string;
  nameUsedAt: number;
  originUrl?: string;
};

// This buffer must cover the largest possible response/checkouts while remaining independent of
// session history. Identity resolution has its own lower subprocess ceiling within this bound.
const PROJECTS_LIST_MAX_RAW_CANDIDATES = Math.max(
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
);

function checkoutName(checkoutPath: string): string {
  const trimmed = checkoutPath.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}

function compareRawProjectCandidates(left: RawProjectCandidate, right: RawProjectCandidate) {
  return (
    right.lastUsedAt - left.lastUsedAt ||
    left.checkoutPath.localeCompare(right.checkoutPath) ||
    left.kind.localeCompare(right.kind)
  );
}

function retainNewestRawProjectCandidate(
  candidates: RawProjectCandidate[],
  candidate: RawProjectCandidate,
) {
  const insertionIndex = candidates.findIndex(
    (existing) => compareRawProjectCandidates(candidate, existing) < 0,
  );
  if (insertionIndex < 0 && candidates.length >= PROJECTS_LIST_MAX_RAW_CANDIDATES) {
    return;
  }
  candidates.splice(insertionIndex < 0 ? candidates.length : insertionIndex, 0, candidate);
  if (candidates.length > PROJECTS_LIST_MAX_RAW_CANDIDATES) {
    candidates.pop();
  }
}

function sanitizePublicOriginUrl(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const suffixIndex = trimmed.search(/[?#]/u);
  const withoutSuffix = suffixIndex < 0 ? trimmed : trimmed.slice(0, suffixIndex);
  const scp = /^[^@\s/:]+@(\[[^\]]+\]|[^:\s]+):(.+)$/u.exec(withoutSuffix);
  if (scp) {
    return `${scp[1]}:${scp[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutSuffix);
  } catch {
    return undefined;
  }
  if (!parsed.username && !parsed.password) {
    return withoutSuffix;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function sanitizeProjectRecord(project: ProjectRecord): ProjectRecord {
  const { originUrl, ...record } = project;
  const sanitizedOriginUrl = originUrl ? sanitizePublicOriginUrl(originUrl) : undefined;
  return {
    ...record,
    ...(sanitizedOriginUrl ? { originUrl: sanitizedOriginUrl } : {}),
  };
}

function projectCandidatesToSummaries(candidates: readonly ProjectCandidate[]): ProjectSummary[] {
  const groups = new Map<string, ProjectGroup>();
  for (const candidate of candidates) {
    const group: ProjectGroup = groups.get(candidate.fingerprint) ?? {
      checkouts: new Map(),
      lastUsedAt: candidate.lastUsedAt,
      name: checkoutName(candidate.checkoutPath),
      nameUsedAt: candidate.lastUsedAt,
    };
    const checkout = group.checkouts.get(candidate.checkoutPath);
    if (!checkout || candidate.lastUsedAt > checkout.lastUsedAt) {
      group.checkouts.set(candidate.checkoutPath, {
        path: candidate.checkoutPath,
        lastUsedAt: candidate.lastUsedAt,
      });
    }
    group.lastUsedAt = Math.max(group.lastUsedAt, candidate.lastUsedAt);
    if (candidate.lastUsedAt > group.nameUsedAt) {
      group.name = checkoutName(candidate.checkoutPath);
      group.nameUsedAt = candidate.lastUsedAt;
    }
    if (!group.originUrl && candidate.originUrl) {
      group.originUrl = candidate.originUrl;
    }
    groups.set(candidate.fingerprint, group);
  }
  return [...groups.values()]
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    )
    .slice(0, PROJECTS_LIST_DEFAULT_LIMIT)
    .map((group) => {
      const summary: ProjectSummary = {
        name: group.name,
        checkouts: [...group.checkouts.values()]
          .toSorted(
            (left, right) =>
              right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path),
          )
          .slice(0, PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT)
          .map((checkout) => ({ runnerId: "gateway", path: checkout.path })),
        lastUsedAt: group.lastUsedAt,
      };
      if (group.originUrl) {
        const originUrl = sanitizePublicOriginUrl(group.originUrl);
        if (originUrl) {
          summary.originUrl = originUrl;
        }
      }
      return summary;
    });
}

export async function listObservedProjects(
  context: Parameters<GatewayRequestHandlers["projects.list"]>[0]["context"],
  client: Parameters<GatewayRequestHandlers["projects.list"]>[0]["client"],
  store: Awaited<ReturnType<typeof loadCombinedSessionStoreForGatewayCoreAsync>>["store"],
  diagnostics?: ReturnType<typeof startProjectsListDiagnostics>,
  readMembership?: (key: string) => ReadonlySet<string> | undefined,
) {
  diagnostics?.mark("worktreeRegistry");
  const worktrees = await managedWorktrees.listRegistryRecords();
  diagnostics?.mark("sessionCandidates");
  const cfg = context.getRuntimeConfig();
  const rawCandidates: RawProjectCandidate[] = [];
  const visibilityFilter = createSessionListEntryFilter({ client, cfg });
  const isVisible = (key: string) =>
    createSessionListEntryFilter({
      client,
      cfg: context.getRuntimeConfig(),
      membership: readMembership?.(key),
    })?.(key, store[key]!) !== false;
  const canSeeAll = !visibilityFilter;
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (visibilityFilter && !isVisible(sessionKey)) {
      continue;
    }
    const checkoutPath = entry.execCwd?.trim();
    if (checkoutPath && !entry.execNode?.trim()) {
      retainNewestRawProjectCandidate(rawCandidates, {
        kind: "session",
        checkoutPath,
        lastUsedAt: entry.updatedAt,
        sessionKey,
      });
    }
  }
  diagnostics?.mark("worktreeCandidates");
  for (const worktree of worktrees) {
    if (worktree.removedAt !== undefined) {
      continue;
    }
    if (!canSeeAll) {
      // Session-owned worktrees use their canonical session key as ownerId, so the same
      // visibility policy that admitted the session also owns its managed checkout.
      const ownerId = worktree.ownerKind === "session" ? worktree.ownerId?.trim() : undefined;
      const ownerEntry = ownerId ? store[ownerId] : undefined;
      if (!ownerId || !ownerEntry || !isVisible(ownerId)) {
        continue;
      }
    }
    retainNewestRawProjectCandidate(rawCandidates, {
      kind: "worktree",
      checkoutPath: worktree.path,
      fingerprint: worktree.repoFingerprint,
      lastUsedAt: worktree.lastActiveAt,
      repoRoot: worktree.repoRoot,
      sessionKey: worktree.ownerKind === "session" ? worktree.ownerId?.trim() : undefined,
    });
  }

  // Admit newest-first paths before canonicalizing the shared discovery pass's key.
  diagnostics?.mark("identityProbes");
  const probePaths = [
    ...new Set(
      rawCandidates.map((raw) => (raw.kind === "worktree" ? raw.repoRoot : raw.checkoutPath)),
    ),
  ]
    .slice(0, PROJECTS_LIST_MAX_IDENTITY_PROBES)
    .toSorted();
  const results = probePaths.length
    ? await managedWorktrees.resolveRepositoryIdentities(probePaths)
    : [];
  const identities = new Map(
    probePaths.map((checkoutPath, index) => [checkoutPath, results[index]]),
  );

  diagnostics?.mark("candidateProcessing");
  const candidates: ProjectCandidate[] = [];
  const usedSessions = new Set<string>();
  for (const raw of rawCandidates) {
    const identity = identities.get(raw.kind === "worktree" ? raw.repoRoot : raw.checkoutPath);
    const checkout =
      raw.kind === "worktree"
        ? { checkoutPath: raw.checkoutPath, fingerprint: raw.fingerprint }
        : identity && { checkoutPath: identity.checkoutRoot, fingerprint: identity.fingerprint };
    if (!checkout) {
      continue;
    }
    if (raw.kind === "session" || !canSeeAll) {
      usedSessions.add(raw.sessionKey!);
    }
    // Registry facts survive a missing source checkout or exhausted probe budget.
    candidates.push({
      ...checkout,
      lastUsedAt: raw.lastUsedAt,
      ...(identity?.originUrl ? { originUrl: identity.originUrl } : {}),
    });
  }

  // M5: merge operator-enabled device checkout advertisements at this seam.
  return {
    projects: projectCandidatesToSummaries(candidates),
    usedSessions,
    assertCurrent() {
      const currentFilter = createSessionListEntryFilter({ client, cfg });
      if (currentFilter && (canSeeAll || [...usedSessions].some((key) => !isVisible(key)))) {
        throw new ProjectListingChangedError();
      }
    },
  };
}
