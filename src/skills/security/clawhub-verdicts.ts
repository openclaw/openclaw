import { resolveClawHubBaseUrl } from "../../infra/clawhub-client.js";
import { fetchExactClawHubSkillSecurityVerdicts } from "../../infra/clawhub-skill-security.js";
import type { ClawHubSkillSecurityVerdictItem } from "../../infra/clawhub-skills.js";
import type { buildWorkspaceSkillStatus } from "../discovery/status.js";

type ClawHubVerdictTarget = {
  registry: string;
  slug: string;
  ownerHandle?: string;
  version: string;
};

type OpenClawSkillSecurityVerdictItem = Omit<
  ClawHubSkillSecurityVerdictItem,
  "decision" | "error" | "security"
> & {
  registry: string;
  decision: string;
  requestedOwnerHandle?: string;
  securityStatus?: string | null;
  securityPassed?: boolean | null;
  error?: {
    code?: string;
    message?: string;
  };
};

function projectClawHubVerdictItem(
  item: ClawHubSkillSecurityVerdictItem,
  target: ClawHubVerdictTarget,
): OpenClawSkillSecurityVerdictItem {
  const projected: OpenClawSkillSecurityVerdictItem = {
    registry: target.registry,
    ok: item.ok,
    decision: item.decision,
    reasons: item.reasons,
    requestedSlug: target.slug,
    requestedVersion: target.version,
    ...(target.ownerHandle ? { requestedOwnerHandle: target.ownerHandle } : {}),
    ...(item.slug !== undefined ? { slug: item.slug } : {}),
    ...(item.version !== undefined ? { version: item.version } : {}),
    ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
    ...(item.publisherHandle !== undefined ? { publisherHandle: item.publisherHandle } : {}),
    ...(item.publisherDisplayName !== undefined
      ? { publisherDisplayName: item.publisherDisplayName }
      : {}),
    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
    ...(item.checkedAt !== undefined ? { checkedAt: item.checkedAt } : {}),
    ...(item.skillUrl !== undefined ? { skillUrl: item.skillUrl } : {}),
    ...(item.securityAuditUrl !== undefined ? { securityAuditUrl: item.securityAuditUrl } : {}),
  };
  const security = item.security;
  if (security && typeof security === "object") {
    if ("status" in security && typeof security.status === "string") {
      projected.securityStatus = security.status;
    }
    if ("passed" in security && typeof security.passed === "boolean") {
      projected.securityPassed = security.passed;
    }
  }
  if (item.error) {
    const error: OpenClawSkillSecurityVerdictItem["error"] = {};
    if (typeof item.error.code === "string") {
      error.code = item.error.code;
    }
    if (typeof item.error.message === "string") {
      error.message = item.error.message;
    }
    if (Object.keys(error).length > 0) {
      projected.error = error;
    }
  }
  return projected;
}

function normalizeAutoVerdictRegistryBase(registry: string): string | null {
  const url = URL.parse(registry);
  return url ? `${url.origin}${url.pathname.replace(/\/+$/, "")}` : null;
}

function canAutoFetchVerdictRegistry(registry: string): boolean {
  const configured = normalizeAutoVerdictRegistryBase(resolveClawHubBaseUrl());
  const target = normalizeAutoVerdictRegistryBase(registry);
  return configured !== null && target === configured;
}

export function collectClawHubVerdictTargets(
  report: ReturnType<typeof buildWorkspaceSkillStatus>,
): ClawHubVerdictTarget[] {
  const targets = new Map<string, ClawHubVerdictTarget>();
  for (const skill of report.skills) {
    const link = skill.clawhub;
    if (!link || link.status !== "linked" || !link.valid) {
      continue;
    }
    if (!canAutoFetchVerdictRegistry(link.registry)) {
      continue;
    }
    const key = `${link.registry}\0${link.ownerHandle ?? ""}\0${link.slug}\0${link.installedVersion}`;
    targets.set(key, {
      registry: link.registry,
      slug: link.slug,
      ...(link.ownerHandle ? { ownerHandle: link.ownerHandle } : {}),
      version: link.installedVersion,
    });
  }
  return [...targets.values()];
}

export async function fetchOpenClawSkillSecurityVerdicts(
  targets: ClawHubVerdictTarget[],
): Promise<OpenClawSkillSecurityVerdictItem[]> {
  const byRegistry = new Map<string, ClawHubVerdictTarget[]>();
  for (const target of targets) {
    const registryTargets = byRegistry.get(target.registry) ?? [];
    registryTargets.push(target);
    byRegistry.set(target.registry, registryTargets);
  }

  const items: OpenClawSkillSecurityVerdictItem[] = [];
  for (const [registry, registryTargets] of byRegistry) {
    const verdicts = await fetchExactClawHubSkillSecurityVerdicts({
      baseUrl: registry,
      items: registryTargets.map(({ slug, ownerHandle, version }) => ({
        slug,
        ...(ownerHandle ? { ownerHandle } : {}),
        version,
      })),
      skipAuth: true,
    });
    for (const [index, item] of verdicts.entries()) {
      items.push(projectClawHubVerdictItem(item, registryTargets[index]!));
    }
  }
  return items;
}
