import type { OperatorRuntimeIdentity } from "./runtime-freshness.js";
import type { OperatorWorkerReadySnapshot } from "./worker-client.js";

export type OperatorWorkerFreshnessSnapshot = {
  ready: boolean;
  status: "ready" | "not-ready" | "unknown";
  reasons: string[];
  policy: {
    maxAgeHours: number | null;
    allowedRefs: string[];
    requireIdentity: boolean;
  };
  identity: OperatorRuntimeIdentity | null;
};

function parseOptionalPositiveNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

function normalizeAllowedRefs(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function coerceOperatorRuntimeIdentity(identity: unknown): OperatorRuntimeIdentity | null {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return null;
  }
  const candidate = identity as Record<string, unknown>;
  const version = typeof candidate.version === "string" ? candidate.version.trim() : "";
  const commit = typeof candidate.commit === "string" ? candidate.commit.trim() || null : null;
  const branch = typeof candidate.branch === "string" ? candidate.branch.trim() || null : null;
  const builtAt = typeof candidate.builtAt === "string" ? candidate.builtAt.trim() || null : null;
  const runtimeType =
    candidate.runtimeType === "embedded" || candidate.runtimeType === "acp"
      ? candidate.runtimeType
      : "unknown";
  if (!version && !commit && !branch && !builtAt) {
    return null;
  }
  return {
    version: version || "unknown",
    commit,
    branch,
    builtAt,
    runtimeType,
  };
}

export function resolveOperatorIdentityFreshness(options: {
  identity: OperatorRuntimeIdentity | null;
  label: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  maxAgeEnv: string;
  approvedRefsEnv: string;
  requireIdentityEnv: string;
  fallbackMaxAgeEnv?: string;
}): {
  ready: boolean;
  status: "ready" | "not-ready" | "unknown";
  reasons: string[];
  policy: {
    maxAgeHours: number | null;
    allowedRefs: string[];
    requireIdentity: boolean;
  };
  identity: OperatorRuntimeIdentity | null;
} {
  const env = options.env ?? process.env;
  const maxAgeHours = parseOptionalPositiveNumber(
    env[options.maxAgeEnv] ??
      (options.fallbackMaxAgeEnv ? env[options.fallbackMaxAgeEnv] : undefined),
  );
  const allowedRefs = normalizeAllowedRefs(env[options.approvedRefsEnv]);
  const requireIdentity = parseBoolean(env[options.requireIdentityEnv]);
  const reasons: string[] = [];
  const identityRequired = requireIdentity || allowedRefs.length > 0 || maxAgeHours !== null;
  const label = options.label;

  if (!options.identity) {
    if (identityRequired) {
      reasons.push(`${label} identity metadata unavailable`);
      return {
        ready: false,
        status: "not-ready",
        reasons,
        policy: { maxAgeHours, allowedRefs, requireIdentity },
        identity: null,
      };
    }
    return {
      ready: true,
      status: "unknown",
      reasons: [`${label} identity metadata unavailable`],
      policy: { maxAgeHours, allowedRefs, requireIdentity },
      identity: null,
    };
  }

  if (maxAgeHours !== null && !options.identity.builtAt) {
    reasons.push(`${label} builtAt metadata unavailable`);
  } else if (maxAgeHours !== null && options.identity.builtAt) {
    const builtAtMs = Date.parse(options.identity.builtAt);
    if (!Number.isFinite(builtAtMs)) {
      reasons.push(`${label} builtAt is invalid (${options.identity.builtAt})`);
    } else {
      const ageHours = ((options.now ?? Date.now()) - builtAtMs) / (60 * 60 * 1000);
      if (ageHours > maxAgeHours) {
        reasons.push(
          `${label} build is stale (${Math.floor(ageHours)}h old > ${Math.floor(maxAgeHours)}h max)`,
        );
      }
    }
  }

  if (allowedRefs.length > 0) {
    const branch = options.identity.branch?.toLowerCase() ?? "";
    const commit = options.identity.commit?.toLowerCase() ?? "";
    const matched = allowedRefs.some(
      (ref) =>
        ref === branch ||
        ref === commit ||
        (commit.length > 0 && ref.length >= commit.length && ref.startsWith(commit)) ||
        (ref.length > 0 && commit.startsWith(ref)),
    );
    if (!matched) {
      reasons.push(
        `${label} ref not approved (branch=${options.identity.branch ?? "unknown"}, commit=${options.identity.commit ?? "unknown"})`,
      );
    }
  }

  return {
    ready: reasons.length === 0,
    status: reasons.length === 0 ? "ready" : "not-ready",
    reasons,
    policy: { maxAgeHours, allowedRefs, requireIdentity },
    identity: options.identity,
  };
}

export function resolveOperatorWorkerFreshness(options: {
  ready: OperatorWorkerReadySnapshot;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): OperatorWorkerFreshnessSnapshot {
  return resolveOperatorIdentityFreshness({
    identity: coerceOperatorRuntimeIdentity((options.ready as Record<string, unknown>).identity),
    label: "worker",
    env: options.env,
    now: options.now,
    maxAgeEnv: "OPENCLAW_OPERATOR_WORKER_MAX_AGE_HOURS",
    approvedRefsEnv: "OPENCLAW_OPERATOR_WORKER_APPROVED_REFS",
    requireIdentityEnv: "OPENCLAW_OPERATOR_REQUIRE_WORKER_IDENTITY",
    fallbackMaxAgeEnv: "OPENCLAW_OPERATOR_RUNTIME_MAX_AGE_HOURS",
  });
}
