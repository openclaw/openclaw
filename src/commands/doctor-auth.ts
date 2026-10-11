import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
  type AuthHealthSummary,
} from "../agents/auth-health.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  hasAnyAuthProfileStoreSource,
  hasLocalAuthProfileStoreSource,
  loadAuthProfileStoreForRuntime,
  resolveApiKeyForProfile,
} from "../agents/auth-profiles.js";
import { formatAuthDoctorHint } from "../agents/auth-profiles/doctor.js";
import {
  buildAuthProfileUnusableHint,
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  formatOAuthRefreshFailureLoginCommandMarkdown,
  type OAuthRefreshFailureReason,
} from "../agents/auth-profiles/oauth-refresh-failure.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "../agents/auth-profiles/ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthStorePathForDisplay } from "../agents/auth-profiles/paths.js";
import {
  inspectPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { buildProviderAuthRecoveryHint } from "../agents/provider-auth-recovery-hint.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { isRecord } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { listUnavailableAuthProfiles } from "./models/auth-unavailability.js";

const OPENAI_PROVIDER_ID = "openai";
const LEGACY_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const LEGACY_CODEX_APIS = new Set(["openai-responses", "openai-completions"]);
const AUTH_PROFILES_CHECK_ID = "core/doctor/auth-profiles";
const COPILOT_NOTICE_KEY = "doctor.githubCopilotAmbientTokenNotice";
const DOCTOR_REAUTH_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_CODEX_PROVIDER_ID]: OPENAI_PROVIDER_ID,
};

/** Explain the retired ambient-token activation once per state directory. */
export function collectCopilotAmbientTokenFindings(
  cfg: OpenClawConfig,
  env = process.env,
): readonly HealthFinding[] {
  if (
    !(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) ||
    env.COPILOT_GITHUB_TOKEN?.trim() ||
    cfg.models?.providers?.["github-copilot"] ||
    Object.values(cfg.auth?.profiles ?? {}).some(
      (profile) => profile.provider === "github-copilot",
    ) ||
    readConfigMachineState<boolean>(COPILOT_NOTICE_KEY, { env })
  ) {
    return [];
  }
  const agentDirs = [undefined, ...listAgentIds(cfg).map((id) => resolveAgentDir(cfg, id, env))];
  for (const agentDir of agentDirs) {
    const store = loadAuthProfileStoreForRuntime(
      agentDir,
      { readOnly: true, allowKeychainPrompt: false },
      env,
    );
    if (Object.values(store.profiles).some((profile) => profile.provider === "github-copilot")) {
      return [];
    }
  }
  let claimed = false;
  updateConfigMachineState<boolean>(
    COPILOT_NOTICE_KEY,
    (shown) => {
      claimed = shown !== true;
      return true;
    },
    { env },
  );
  if (claimed) {
    return [
      {
        checkId: "core/doctor/copilot-ambient-token",
        severity: "info",
        category: "recommended",
        message: "GitHub Copilot is no longer enabled by GH_TOKEN/GITHUB_TOKEN.",
        fixHint:
          "To use Copilot, run openclaw models auth login --provider github-copilot or set COPILOT_GITHUB_TOKEN. No action needed if you do not use Copilot.",
        docsUrl: "https://docs.openclaw.ai/providers/github-copilot",
      },
    ];
  }
  return [];
}

/** Surface the one-time relocation while the legacy shared owner is still active. */
export function collectSharedAuthStoreFindings(
  env: NodeJS.ProcessEnv = process.env,
): readonly HealthFinding[] {
  if (
    resolveSharedAuthStoreOwnership(env).location !== "legacy-main" ||
    inspectPersistedSharedAuthProfileStoreRaw(env).status !== "readable"
  ) {
    return [];
  }
  return [
    {
      checkId: "core/doctor/shared-auth-store",
      severity: "warning",
      category: "recommended",
      message: "Shared auth profiles still live in the main agent database.",
      fixHint:
        "Run openclaw doctor --fix to move them into shared SQLite state and make the main agent deletable.",
      docsUrl: "https://docs.openclaw.ai/concepts/oauth",
    },
  ];
}

function hasConfiguredCodexOAuthProfile(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.auth?.profiles ?? {}).some(
    (profile) =>
      (profile.provider === OPENAI_PROVIDER_ID || profile.provider === LEGACY_CODEX_PROVIDER_ID) &&
      profile.mode === "oauth",
  );
}

function hasStoredCodexOAuthProfile(): boolean {
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false, readOnly: true });
  return Object.values(store.profiles).some(
    (profile) =>
      (profile.provider === OPENAI_PROVIDER_ID || profile.provider === LEGACY_CODEX_PROVIDER_ID) &&
      profile.type === "oauth",
  );
}

function normalizeCodexOverrideBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string") {
    return undefined;
  }
  return baseUrl.trim().replace(/\/+$/, "");
}

function isLegacyCodexTransportShape(value: unknown, inheritedBaseUrl?: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const api = typeof value.api === "string" ? value.api : undefined;
  if (!api || !LEGACY_CODEX_APIS.has(api)) {
    return false;
  }
  const baseUrl = normalizeCodexOverrideBaseUrl(value.baseUrl ?? inheritedBaseUrl);
  return !baseUrl || baseUrl === OPENAI_BASE_URL;
}

function hasLegacyCodexTransportOverride(providerOverride: unknown): boolean {
  if (!isRecord(providerOverride)) {
    return false;
  }
  if (isLegacyCodexTransportShape(providerOverride)) {
    return true;
  }
  const models = providerOverride.models;
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some((model) => isLegacyCodexTransportShape(model, providerOverride.baseUrl));
}

function buildCodexProviderOverrideWarning(providerOverride: unknown): string {
  const lines = [
    `- models.providers.${LEGACY_CODEX_PROVIDER_ID} contains a legacy transport override while Codex OAuth is configured.`,
    "- Older OpenAI transport settings can shadow the built-in Codex OAuth provider path.",
  ];
  if (isRecord(providerOverride)) {
    const record = providerOverride;
    if (typeof record.api === "string") {
      lines.push(`- models.providers.${LEGACY_CODEX_PROVIDER_ID}.api=${record.api}`);
    }
    if (typeof record.baseUrl === "string") {
      lines.push(`- models.providers.${LEGACY_CODEX_PROVIDER_ID}.baseUrl=${record.baseUrl}`);
    }
  }
  lines.push(
    `- Remove or rewrite the legacy transport override to restore the built-in Codex OAuth provider path after recent fixes.`,
  );
  lines.push(
    "- Custom proxies and header-only overrides can stay; this warning only targets old OpenAI transport settings.",
  );
  return lines.join("\n");
}

export function collectLegacyCodexProviderOverrideFindings(
  cfg: OpenClawConfig,
): readonly HealthFinding[] {
  const providerOverride = cfg.models?.providers?.[LEGACY_CODEX_PROVIDER_ID];
  if (!providerOverride) {
    return [];
  }
  if (!hasLegacyCodexTransportOverride(providerOverride)) {
    return [];
  }
  if (!hasConfiguredCodexOAuthProfile(cfg) && !hasStoredCodexOAuthProfile()) {
    return [];
  }
  return [
    {
      checkId: AUTH_PROFILES_CHECK_ID,
      severity: "warning",
      category: "fix-now",
      message:
        "Legacy openai-codex transport override can shadow configured Codex OAuth credentials.",
      path: `models.providers.${LEGACY_CODEX_PROVIDER_ID}`,
      target: LEGACY_CODEX_PROVIDER_ID,
      fixHint: buildCodexProviderOverrideWarning(providerOverride),
      docsUrl: "https://docs.openclaw.ai/providers/openai",
    },
  ];
}

type AuthIssue = AuthHealthSummary["profiles"][number];

type AuthProfileHealthTarget = {
  label: string;
  agentDir?: string;
};

function listAuthProfileHealthTargets(cfg: OpenClawConfig): AuthProfileHealthTarget[] {
  const targets = new Map<string, AuthProfileHealthTarget>();
  if (hasAnyAuthProfileStoreSource() || Object.keys(cfg.auth?.profiles ?? {}).length > 0) {
    targets.set(resolveSharedAuthStorePath(), { label: "Shared" });
  }
  for (const agentId of listAgentIds(cfg)) {
    const agentDir = resolveAgentDir(cfg, agentId);
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    if (!targets.has(databasePath) && hasLocalAuthProfileStoreSource(agentDir)) {
      targets.set(databasePath, { label: `Agent ${agentId}`, agentDir });
    }
  }

  return [...targets.values()];
}

function formatOAuthRefreshFailureReason(reason: OAuthRefreshFailureReason | null): string {
  switch (reason) {
    case "refresh_token_reused":
    case "expired":
    case "invalid_grant":
    case "revoked":
      return reason;
    case "sign_in_again":
      return "sign in again";
    case "invalid_refresh_token":
      return "invalid refresh token";
    default:
      return "refresh failed";
  }
}

function formatOAuthRefreshFailureDoctorLine(params: {
  profileId: string;
  provider: string;
  message: string;
}): string | null {
  const classified = classifyOAuthRefreshFailure(params.message);
  if (!classified) {
    return null;
  }
  const rawProvider = classified.provider ?? params.provider;
  const provider = rawProvider
    ? (DOCTOR_REAUTH_PROVIDER_ALIASES[rawProvider] ?? rawProvider)
    : null;
  const command = buildOAuthRefreshFailureLoginCommand(provider, {
    profileId: provider === rawProvider ? params.profileId : undefined,
  });
  const commandMarkdown = formatOAuthRefreshFailureLoginCommandMarkdown(command);
  if (classified.reason) {
    return `- ${params.profileId}: re-auth required [${formatOAuthRefreshFailureReason(classified.reason)}] — Run ${commandMarkdown}.`;
  }
  return `- ${params.profileId}: OAuth refresh failed — Try again; if this persists, run ${commandMarkdown}.`;
}

async function resolveAuthIssueHint(
  issue: AuthIssue,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
): Promise<string> {
  if (issue.reasonCode === "invalid_expires") {
    return "Invalid token expires metadata. Set a future Unix ms timestamp or remove expires.";
  }
  if (issue.reasonCode === "malformed_api_key") {
    return "Paste the API key value, not an OpenClaw onboarding command.";
  }
  const providerHint = await formatAuthDoctorHint({
    cfg,
    store,
    provider: issue.provider,
    profileId: issue.profileId,
  });
  if (providerHint.trim()) {
    return providerHint;
  }
  return buildProviderAuthRecoveryHint({
    provider: issue.provider,
  }).replace(/^Run /, "Re-auth via ");
}

function collectAuthProfileCooldowns(store: ReturnType<typeof ensureAuthProfileStore>) {
  return listUnavailableAuthProfiles(store).map(
    ({ profileId, provider, kind, reason, classification, remainingMs }) => {
      const displayReason = classification ?? reason;
      return {
        profileId,
        kind: `${kind}${displayReason ? `:${displayReason}` : ""}`,
        remaining: formatRemainingShort(remainingMs),
        hint: buildAuthProfileUnusableHint({
          kind,
          reason,
          // Local cooldowns can refer to shared credentials, whose expiry is checked separately.
          provider:
            provider ?? findPersistedAuthProfileCredential({ profileId })?.provider ?? profileId,
          profileId,
        }),
      };
    },
  );
}

function isAuthProfileHealthIssue(profile: AuthHealthSummary["profiles"][number]): boolean {
  if (profile.type === "api_key") {
    return profile.status === "missing";
  }
  return (
    (profile.type === "oauth" || profile.type === "token") &&
    (profile.status === "expired" || profile.status === "expiring" || profile.status === "missing")
  );
}

function loadAuthProfileHealth(params: {
  cfg: OpenClawConfig;
  target: AuthProfileHealthTarget;
  allowKeychainPrompt: boolean;
  readOnly?: boolean;
}) {
  // Same-store inheritance keeps local cooldowns and CLI overlays. Credential health follows
  // canonical OAuth ownership, so stale local copies cannot refresh shared credentials twice.
  const store = loadAuthProfileStoreForRuntime(params.target.agentDir, {
    inheritedAuthDir: params.target.agentDir,
    allowKeychainPrompt: params.allowKeychainPrompt,
    readOnly: params.readOnly,
  });
  const profiles = params.target.agentDir
    ? Object.fromEntries(
        Object.entries(store.profiles).filter(
          ([profileId, local]) =>
            local.type !== "oauth" ||
            !shouldUseMainOwnerForLocalOAuthCredential({
              profileId,
              local,
              main: findPersistedAuthProfileCredential({ profileId }),
            }),
        ),
      )
    : store.profiles;
  return {
    store,
    summary: buildAuthHealthSummary({
      store: { ...store, profiles },
      cfg: params.cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    }),
  };
}

async function collectAuthProfileTargetFindings(params: {
  cfg: OpenClawConfig;
  target: AuthProfileHealthTarget;
  labelStores: boolean;
  store: ReturnType<typeof ensureAuthProfileStore>;
  summary: AuthHealthSummary;
}): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const owner = params.labelStores ? `${params.target.label} auth profile` : "Auth profile";
  const path = resolveAuthStorePathForDisplay(params.target.agentDir);
  for (const cooldown of collectAuthProfileCooldowns(params.store)) {
    findings.push({
      checkId: AUTH_PROFILES_CHECK_ID,
      severity: "warning",
      category: "fix-now",
      message: `${owner} ${cooldown.profileId} is ${cooldown.kind} (${cooldown.remaining}).`,
      path,
      target: cooldown.profileId,
      fixHint: cooldown.hint,
      docsUrl: "https://docs.openclaw.ai/concepts/oauth",
    });
  }
  for (const issue of params.summary.profiles.filter(isAuthProfileHealthIssue)) {
    const remaining =
      issue.remainingMs !== undefined ? ` (${formatRemainingShort(issue.remainingMs)})` : "";
    const reason = issue.reasonCode ? ` [${issue.reasonCode}]` : "";
    findings.push({
      checkId: AUTH_PROFILES_CHECK_ID,
      severity: "warning",
      category: issue.status === "expiring" ? "recommended" : "fix-now",
      message: `${owner} ${issue.profileId} is ${issue.status}${reason}${remaining}.`,
      path,
      target: issue.profileId,
      ...(issue.reasonCode ? { requirement: issue.reasonCode } : {}),
      fixHint: await resolveAuthIssueHint(issue, params.cfg, params.store),
      docsUrl: "https://docs.openclaw.ai/concepts/oauth",
    });
  }
  return findings;
}

/** Collects read-only structured findings for auth profile health. */
export async function collectAuthProfileHealthFindings(params: {
  cfg: OpenClawConfig;
  allowKeychainPrompt?: boolean;
}): Promise<readonly HealthFinding[]> {
  const targets = listAuthProfileHealthTargets(params.cfg);
  const findings: HealthFinding[] = [];
  for (const target of targets) {
    const health = loadAuthProfileHealth({
      cfg: params.cfg,
      target,
      allowKeychainPrompt: params.allowKeychainPrompt ?? false,
      readOnly: true,
    });
    findings.push(
      ...(await collectAuthProfileTargetFindings({
        ...params,
        ...health,
        target,
        labelStores: targets.length > 1,
      })),
    );
  }
  return [...findings, ...collectLegacyCodexProviderOverrideFindings(params.cfg)];
}

async function inspectAuthProfileHealthTarget(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
  target: AuthProfileHealthTarget;
  labelStores: boolean;
}): Promise<readonly HealthFinding[]> {
  let { store, summary } = loadAuthProfileHealth(params);
  const refreshTargets = summary.profiles
    .filter(isAuthProfileHealthIssue)
    .filter((issue) => issue.type === "oauth");
  const refreshErrors = new Map<string, string>();
  const shouldRefresh =
    refreshTargets.length > 0 &&
    (await params.prompter.confirmAutoFix({
      message: "Refresh expiring OAuth tokens now? (static tokens need re-auth)",
      initialValue: true,
    }));
  if (shouldRefresh) {
    for (const profile of refreshTargets) {
      try {
        await resolveApiKeyForProfile({
          cfg: params.cfg,
          store,
          profileId: profile.profileId,
          agentDir: params.target.agentDir,
          forceRefresh: true,
        });
      } catch (error) {
        const message = formatErrorMessage(error);
        refreshErrors.set(
          profile.profileId,
          formatOAuthRefreshFailureDoctorLine({
            profileId: profile.profileId,
            provider: profile.provider,
            message,
          }) ?? `OAuth refresh failed: ${message}`,
        );
      }
    }
    ({ store, summary } = loadAuthProfileHealth({ ...params, allowKeychainPrompt: false }));
  }
  const findings = await collectAuthProfileTargetFindings({ ...params, store, summary });
  return findings.map((finding) => {
    const error = finding.target && refreshErrors.get(finding.target);
    return error ? { ...finding, message: `${finding.message} ${error}` } : finding;
  });
}

export async function inspectAuthProfileHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
}): Promise<readonly HealthFinding[]> {
  const targets = listAuthProfileHealthTargets(params.cfg);
  const findings: HealthFinding[] = [];
  for (const target of targets) {
    findings.push(
      ...(await inspectAuthProfileHealthTarget({
        ...params,
        target,
        labelStores: targets.length > 1,
      })),
    );
  }
  return findings;
}
