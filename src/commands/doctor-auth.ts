import { note } from "@clack/prompts";

import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../agents/auth-health.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  repairOAuthProfileIdMismatch,
  resolveApiKeyForProfile,
} from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function maybeRepairAnthropicOAuthProfileId(
  cfg: ClawdbotConfig,
  prompter: DoctorPrompter,
): Promise<ClawdbotConfig> {
  const store = ensureAuthProfileStore();
  const repair = repairOAuthProfileIdMismatch({
    cfg,
    store,
    provider: "anthropic",
    legacyProfileId: "anthropic:default",
  });
  if (!repair.migrated || repair.changes.length === 0) return cfg;

  note(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
  const apply = await prompter.confirm({
    message: "Update Anthropic OAuth profile id in config now?",
    initialValue: true,
  });
  if (!apply) return cfg;
  return repair.config;
}

type AuthIssue = {
  profileId: string;
  provider: string;
  status: string;
  remainingMs?: number;
};

function formatAuthIssueHint(issue: AuthIssue): string | null {
  if (
    issue.provider === "anthropic" &&
    issue.profileId === CLAUDE_CLI_PROFILE_ID
  ) {
    return "Run `claude setup-token` on the gateway host.";
  }
  if (
    issue.provider === "openai-codex" &&
    issue.profileId === CODEX_CLI_PROFILE_ID
  ) {
    return "Run `codex login` (or `clawdbot configure` → OpenAI Codex OAuth).";
  }
  return "Re-auth via `clawdbot configure` or `clawdbot onboard`.";
}

function formatAuthIssueLine(issue: AuthIssue): string {
  const remaining =
    issue.remainingMs !== undefined
      ? ` (${formatRemainingShort(issue.remainingMs)})`
      : "";
  const hint = formatAuthIssueHint(issue);
  return `- ${issue.profileId}: ${issue.status}${remaining}${hint ? ` — ${hint}` : ""}`;
}

export async function noteAuthProfileHealth(params: {
  cfg: ClawdbotConfig;
  prompter: DoctorPrompter;
  allowKeychainPrompt: boolean;
}): Promise<void> {
  const store = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  let summary = buildAuthHealthSummary({
    store,
    cfg: params.cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
  });

  const findIssues = () =>
    summary.profiles.filter(
      (profile) =>
        profile.type === "oauth" &&
        (profile.status === "expired" ||
          profile.status === "expiring" ||
          profile.status === "missing"),
    );

  let issues = findIssues();
  if (issues.length === 0) return;

  const shouldRefresh = await params.prompter.confirmRepair({
    message: "Refresh expiring OAuth tokens now?",
    initialValue: true,
  });

  if (shouldRefresh) {
    const refreshTargets = issues.filter((issue) =>
      ["expired", "expiring", "missing"].includes(issue.status),
    );
    const errors: string[] = [];
    for (const profile of refreshTargets) {
      try {
        await resolveApiKeyForProfile({
          cfg: params.cfg,
          store,
          profileId: profile.profileId,
        });
      } catch (err) {
        errors.push(
          `- ${profile.profileId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (errors.length > 0) {
      note(errors.join("\n"), "OAuth refresh errors");
    }
    summary = buildAuthHealthSummary({
      store: ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      }),
      cfg: params.cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    });
    issues = findIssues();
  }

  if (issues.length > 0) {
    note(
      issues
        .map((issue) =>
          formatAuthIssueLine({
            profileId: issue.profileId,
            provider: issue.provider,
            status: issue.status,
            remainingMs: issue.remainingMs,
          }),
        )
        .join("\n"),
      "Model auth",
    );
  }
}
