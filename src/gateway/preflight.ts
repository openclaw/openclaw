import type {
  AuthProfileCredential,
  AuthProfileStore,
  ProfileUsageStats,
} from "../agents/auth-profiles/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/preflight");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreflightCheckStatus = "pass" | "warn" | "fail";

export type PreflightErrorCode =
  | "NO_CREDENTIALS"
  | "CREDENTIALS_EXPIRED"
  | "CREDENTIALS_EXPIRING"
  | "AUTH_PERMANENT_FAILURE"
  | "FALLBACK_NO_CREDENTIALS"
  | "ALL_PROFILES_COOLDOWN"
  | "PROVIDER_HEALTHY";

export type PreflightCheckResult = {
  status: PreflightCheckStatus;
  provider: string;
  model?: string;
  code: PreflightErrorCode;
  message: string;
  playbook: string;
};

export type PreflightSummary = {
  ok: boolean;
  checks: PreflightCheckResult[];
  timestamp: number;
};

type PreflightCatalogEntry = {
  code: PreflightErrorCode;
  severity: PreflightCheckStatus;
  message: string;
  playbook: string;
};

// ---------------------------------------------------------------------------
// Error catalog with playbooks
// ---------------------------------------------------------------------------

export const PREFLIGHT_ERROR_CATALOG: Record<PreflightErrorCode, PreflightCatalogEntry> = {
  NO_CREDENTIALS: {
    code: "NO_CREDENTIALS",
    severity: "fail",
    message: "No valid credentials found for provider",
    playbook:
      "Run `openclaw login <provider>` to authenticate, or add an API key via `openclaw config set models.providers.<provider>.apiKey <key>`.",
  },
  CREDENTIALS_EXPIRED: {
    code: "CREDENTIALS_EXPIRED",
    severity: "fail",
    message: "Credentials have expired",
    playbook:
      "Run `openclaw login <provider>` to refresh your credentials. If using an API key, generate a new one from your provider dashboard.",
  },
  CREDENTIALS_EXPIRING: {
    code: "CREDENTIALS_EXPIRING",
    severity: "warn",
    message: "Credentials are expiring soon",
    playbook:
      "Run `openclaw login <provider>` to refresh before expiry. Credentials with a refresh token will auto-renew on next use.",
  },
  AUTH_PERMANENT_FAILURE: {
    code: "AUTH_PERMANENT_FAILURE",
    severity: "fail",
    message: "API key has been revoked, deactivated, or has a permanent billing issue",
    playbook:
      "Generate a new API key from your provider dashboard. If billing-related, check your provider account balance and payment method.",
  },
  FALLBACK_NO_CREDENTIALS: {
    code: "FALLBACK_NO_CREDENTIALS",
    severity: "fail",
    message: "Fallback model has no valid credentials",
    playbook:
      "Add credentials for the fallback provider via `openclaw login <provider>`, or remove the model from your fallback chain in config.",
  },
  ALL_PROFILES_COOLDOWN: {
    code: "ALL_PROFILES_COOLDOWN",
    severity: "warn",
    message: "All auth profiles are in cooldown",
    playbook:
      "Cooldowns are temporary (rate limit or transient error). Service will auto-recover. If persistent, check `openclaw status --deep` for details.",
  },
  PROVIDER_HEALTHY: {
    code: "PROVIDER_HEALTHY",
    severity: "pass",
    message: "Provider credentials are valid and ready",
    playbook: "No action needed.",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WARN_EXPIRY_MS = 60 * 60_000; // 1 hour

/** Persistent disable reasons that indicate a non-recoverable auth issue. */
const PERSISTENT_DISABLE_REASONS = new Set(["auth_permanent", "auth", "billing"]);

function listProfilesForProvider(
  store: AuthProfileStore,
  provider: string,
): { profileId: string; credential: AuthProfileCredential }[] {
  const normalized = provider.trim().toLowerCase();
  return Object.entries(store.profiles)
    .filter(([, cred]) => cred.provider.trim().toLowerCase() === normalized)
    .map(([profileId, credential]) => ({ profileId, credential }));
}

function isCredentialStructurallyValid(cred: AuthProfileCredential): boolean {
  if (cred.type === "api_key") {
    return Boolean(cred.key?.trim());
  }
  if (cred.type === "token") {
    return Boolean(cred.token?.trim());
  }
  if (cred.type === "oauth") {
    // OAuth with refresh token can renew; with just access token it needs to be present.
    return Boolean(
      (cred as { access?: string }).access?.trim() ||
      (cred as { refresh?: string }).refresh?.trim(),
    );
  }
  return false;
}

function isTokenExpired(cred: AuthProfileCredential, now: number): boolean {
  if (cred.type === "token") {
    if (typeof cred.expires === "number" && Number.isFinite(cred.expires) && cred.expires > 0) {
      return now >= cred.expires;
    }
  }
  if (cred.type === "oauth") {
    const oauthCred = cred as { expires?: number; refresh?: string };
    // OAuth with refresh token auto-renews — don't treat as expired.
    if (oauthCred.refresh?.trim()) {
      return false;
    }
    if (
      typeof oauthCred.expires === "number" &&
      Number.isFinite(oauthCred.expires) &&
      oauthCred.expires > 0
    ) {
      return now >= oauthCred.expires;
    }
  }
  return false;
}

function isTokenExpiringSoon(cred: AuthProfileCredential, now: number, warnMs: number): boolean {
  const expiresAt = (() => {
    if (cred.type === "token") {
      return cred.expires;
    }
    if (cred.type === "oauth") {
      // OAuth with refresh skips expiry warnings.
      if ((cred as { refresh?: string }).refresh?.trim()) {
        return undefined;
      }
      return (cred as { expires?: number }).expires;
    }
    return undefined;
  })();
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return false;
  }
  const remaining = expiresAt - now;
  return remaining > 0 && remaining <= warnMs;
}

function isProfilePermanentlyDisabled(
  store: AuthProfileStore,
  profileId: string,
  now: number,
): { disabled: true; reason: string } | { disabled: false } {
  const stats: ProfileUsageStats | undefined = store.usageStats?.[profileId];
  if (!stats) {
    return { disabled: false };
  }
  if (
    typeof stats.disabledUntil === "number" &&
    Number.isFinite(stats.disabledUntil) &&
    stats.disabledUntil > 0 &&
    now < stats.disabledUntil &&
    stats.disabledReason &&
    PERSISTENT_DISABLE_REASONS.has(stats.disabledReason)
  ) {
    return { disabled: true, reason: stats.disabledReason };
  }
  return { disabled: false };
}

function isProfileInCooldown(store: AuthProfileStore, profileId: string, now: number): boolean {
  const stats: ProfileUsageStats | undefined = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  if (
    typeof stats.cooldownUntil === "number" &&
    Number.isFinite(stats.cooldownUntil) &&
    stats.cooldownUntil > 0 &&
    now < stats.cooldownUntil
  ) {
    return true;
  }
  if (
    typeof stats.disabledUntil === "number" &&
    Number.isFinite(stats.disabledUntil) &&
    stats.disabledUntil > 0 &&
    now < stats.disabledUntil
  ) {
    return true;
  }
  return false;
}

function buildCheck(
  code: PreflightErrorCode,
  provider: string,
  model?: string,
): PreflightCheckResult {
  const entry = PREFLIGHT_ERROR_CATALOG[code];
  const providerLabel = provider.trim();
  const modelLabel = model?.trim();
  const target = modelLabel ? `${providerLabel}/${modelLabel}` : providerLabel;
  return {
    status: entry.severity,
    provider: providerLabel,
    model: modelLabel,
    code,
    message: `${target}: ${entry.message}`,
    playbook: entry.playbook.replaceAll("<provider>", providerLabel),
  };
}

// ---------------------------------------------------------------------------
// Main preflight runner
// ---------------------------------------------------------------------------

export type PreflightParams = {
  /** List of provider names to validate (e.g. ["anthropic", "openai"]). */
  providers: string[];
  /** Auth profile store snapshot. */
  authStore: AuthProfileStore;
  /** Optional fallback model chain to validate credentials for. */
  fallbackModels?: Array<{ provider: string; model: string }>;
  /** Warn when token expires within this many ms (default: 1h). */
  warnExpiryMs?: number;
  /** Providers that have API key configured outside auth-profiles (env/config). */
  externalApiKeyProviders?: string[];
};

export function runPreflightChecks(params: PreflightParams): PreflightSummary {
  const { providers, authStore, fallbackModels, warnExpiryMs, externalApiKeyProviders } = params;
  const warnMs = warnExpiryMs ?? DEFAULT_WARN_EXPIRY_MS;
  const now = Date.now();
  const checks: PreflightCheckResult[] = [];
  const externalKeyProviders = new Set(
    (externalApiKeyProviders ?? []).map((p) => p.trim().toLowerCase()),
  );

  // Track which providers have been validated so we can skip duplicates in fallback.
  const validatedProviders = new Set<string>();

  for (const provider of providers) {
    const check = validateProvider(
      authStore,
      provider,
      now,
      warnMs,
      externalKeyProviders.has(provider.trim().toLowerCase()),
    );
    checks.push(check);
    validatedProviders.add(provider.trim().toLowerCase());
  }

  // Validate fallback chain: each fallback model must have credentials for its provider.
  if (fallbackModels) {
    for (const fallback of fallbackModels) {
      const normalizedProvider = fallback.provider.trim().toLowerCase();
      if (validatedProviders.has(normalizedProvider)) {
        // Provider already validated in the primary list — skip duplicate check.
        continue;
      }
      validatedProviders.add(normalizedProvider);
      const fallbackCheck = validateProvider(
        authStore,
        fallback.provider,
        now,
        warnMs,
        externalKeyProviders.has(normalizedProvider),
      );
      if (fallbackCheck.code !== "PROVIDER_HEALTHY") {
        const code =
          fallbackCheck.code === "NO_CREDENTIALS" ? "FALLBACK_NO_CREDENTIALS" : fallbackCheck.code;
        checks.push(buildCheck(code, fallback.provider, fallback.model));
      }
    }
  }

  const hasFail = checks.some((c) => c.status === "fail");
  return {
    ok: !hasFail,
    checks,
    timestamp: now,
  };
}

function validateProvider(
  store: AuthProfileStore,
  provider: string,
  now: number,
  warnMs: number,
  hasExternalApiKey: boolean,
): PreflightCheckResult {
  const profiles = listProfilesForProvider(store, provider);

  // No profiles at all for this provider.
  if (profiles.length === 0) {
    return hasExternalApiKey
      ? buildCheck("PROVIDER_HEALTHY", provider)
      : buildCheck("NO_CREDENTIALS", provider);
  }

  // Filter to structurally valid credentials.
  const validProfiles = profiles.filter(({ credential }) =>
    isCredentialStructurallyValid(credential),
  );
  if (validProfiles.length === 0) {
    return hasExternalApiKey
      ? buildCheck("PROVIDER_HEALTHY", provider)
      : buildCheck("NO_CREDENTIALS", provider);
  }

  // Check for permanent disable on ALL profiles.
  const permanentDisableResults = validProfiles.map(({ profileId }) =>
    isProfilePermanentlyDisabled(store, profileId, now),
  );
  if (permanentDisableResults.every((r) => r.disabled)) {
    return buildCheck("AUTH_PERMANENT_FAILURE", provider);
  }

  // Check for token expiry on ALL non-permanently-disabled profiles.
  const activeProfiles = validProfiles.filter((_, i) => !permanentDisableResults[i].disabled);
  const allExpired = activeProfiles.every(({ credential }) => isTokenExpired(credential, now));
  if (activeProfiles.length > 0 && allExpired) {
    return buildCheck("CREDENTIALS_EXPIRED", provider);
  }

  // Check for expiring-soon warning first — this requires user action.
  const nonExpiredProfiles = activeProfiles.filter(
    ({ credential }) => !isTokenExpired(credential, now),
  );
  const anyExpiringSoon = nonExpiredProfiles.some(({ credential }) =>
    isTokenExpiringSoon(credential, now, warnMs),
  );
  if (anyExpiringSoon) {
    return buildCheck("CREDENTIALS_EXPIRING", provider);
  }

  // Check all profiles in cooldown (transient — warn only).
  const allInCooldown = validProfiles.every(({ profileId }) =>
    isProfileInCooldown(store, profileId, now),
  );
  if (allInCooldown) {
    return buildCheck("ALL_PROFILES_COOLDOWN", provider);
  }

  return buildCheck("PROVIDER_HEALTHY", provider);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPreflightSummary(summary: PreflightSummary): string {
  if (summary.checks.length === 0) {
    return "Preflight: no providers configured.";
  }

  const lines: string[] = [];
  lines.push(summary.ok ? "Preflight: all checks passed." : "Preflight: issues detected.");
  lines.push("");

  for (const check of summary.checks) {
    const statusLabel = check.status.toUpperCase().padEnd(4);
    lines.push(`  [${statusLabel}] ${check.message}`);
    if (check.status !== "pass") {
      lines.push(`         → ${check.playbook}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Gateway integration helper
// ---------------------------------------------------------------------------

/**
 * Run preflight and log results. Intended to be called during gateway startup.
 * Does NOT block startup — logs warnings/errors and returns the summary.
 */
export function runAndLogPreflight(params: PreflightParams): PreflightSummary {
  const summary = runPreflightChecks(params);
  const formatted = formatPreflightSummary(summary);

  if (summary.ok) {
    log.info(formatted);
  } else {
    log.warn(formatted);
    for (const check of summary.checks) {
      if (check.status === "fail") {
        log.error(`Preflight failure: ${check.message}`, {
          code: check.code,
          provider: check.provider,
          model: check.model,
        });
      }
    }
  }

  return summary;
}
