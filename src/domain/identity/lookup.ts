import type { Channel, Role, SubjectCandidate } from "./stateMachine.js";

type IdentityLookupDeps = {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  warn?: (message: string) => void;
};

type IdentityLookupInput = {
  channel: Channel;
  channelIdentity: string;
  intentSlug: string;
};

type IdentityLookupFn = (input: IdentityLookupInput) => Promise<SubjectCandidate[]>;

const DEFAULT_TIMEOUT_MS = 2_000;

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRole(value: unknown): Role {
  if (value === "pm" || value === "owner" || value === "renter" || value === "vendor") {
    return value;
  }
  return "unknown";
}

function parseIdentityConfidence(value: unknown): "high" | "medium" | "low" {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "medium";
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function normalizeSubjectCandidate(value: unknown): SubjectCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const subjectId = typeof candidate.subjectId === "string" ? candidate.subjectId.trim() : "";
  if (!subjectId) {
    return null;
  }

  const lastVerifiedAtRaw = candidate.lastVerifiedAtMs;
  const lastVerifiedAtMs =
    typeof lastVerifiedAtRaw === "number" && Number.isFinite(lastVerifiedAtRaw)
      ? lastVerifiedAtRaw
      : undefined;

  return {
    subjectId,
    role: parseRole(candidate.role),
    allowedPropertyIds: parseStringArray(candidate.allowedPropertyIds),
    allowedUnitIds: parseStringArray(candidate.allowedUnitIds),
    allowedWorkOrderIds: parseStringArray(candidate.allowedWorkOrderIds),
    lastVerifiedAtMs,
    identityConfidence: parseIdentityConfidence(candidate.identityConfidence),
  };
}

function parseCandidatesPayload(payload: unknown): SubjectCandidate[] {
  if (Array.isArray(payload)) {
    return payload
      .map(normalizeSubjectCandidate)
      .filter((value): value is SubjectCandidate => !!value);
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const objectPayload = payload as Record<string, unknown>;
  if (!Array.isArray(objectPayload.candidates)) {
    return [];
  }
  return objectPayload.candidates
    .map(normalizeSubjectCandidate)
    .filter((value): value is SubjectCandidate => !!value);
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.trunc(parsed);
}

export function createIdentityLookupFromEnv(deps?: IdentityLookupDeps): IdentityLookupFn {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const nowMs = deps?.nowMs ?? (() => Date.now());
  const lookupUrl = process.env.OPENCLAW_IDENTITY_LOOKUP_URL?.trim();
  const bearerToken = process.env.OPENCLAW_IDENTITY_LOOKUP_TOKEN?.trim();
  const timeoutMs = parseTimeoutMs(process.env.OPENCLAW_IDENTITY_LOOKUP_TIMEOUT_MS);
  const staticAllowedUnits = parseCsvEnv(process.env.OPENCLAW_IDENTITY_LOOKUP_FALLBACK_UNITS);
  const staticAllowedProperties = parseCsvEnv(
    process.env.OPENCLAW_IDENTITY_LOOKUP_FALLBACK_PROPERTIES,
  );
  const staticRole = parseRole(process.env.OPENCLAW_IDENTITY_LOOKUP_FALLBACK_ROLE);

  return async (input: IdentityLookupInput): Promise<SubjectCandidate[]> => {
    if (!lookupUrl) {
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(lookupUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({
          channel: input.channel,
          channelIdentity: input.channelIdentity,
          intentSlug: input.intentSlug,
          requestedAtMs: nowMs(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        deps?.warn?.(`identity lookup http ${response.status}`);
        return [];
      }

      const json = (await response.json()) as unknown;
      const parsed = parseCandidatesPayload(json);
      if (parsed.length > 0) {
        return parsed;
      }

      if (staticAllowedUnits.length > 0) {
        return [
          {
            subjectId: `fallback:${input.channelIdentity}`,
            role: staticRole,
            allowedPropertyIds: staticAllowedProperties,
            allowedUnitIds: staticAllowedUnits,
            allowedWorkOrderIds: [],
            identityConfidence: "low",
          },
        ];
      }

      return [];
    } catch (error) {
      deps?.warn?.(`identity lookup failed: ${String(error)}`);
      return [];
    } finally {
      clearTimeout(timeout);
    }
  };
}
