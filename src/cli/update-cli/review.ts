/**
 * `openclaw update review` — pre-update risk assessment.
 *
 * Fetches the latest release from the npm registry, summarises what changed
 * relative to the installed version, and emits a risk-tiered recommendation
 * card with any local-config implications before the user decides whether to
 * run `openclaw update`.
 */

import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import {
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { theme } from "../../terminal/theme.js";
import { VERSION } from "../../version.js";
import { formatCliCommand } from "../command-format.js";
import { parseTimeoutMsOrExit, resolveUpdateRoot } from "./shared.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type UpdateReviewOptions = {
  json?: boolean;
  timeout?: string;
};

export type RiskLevel = "low" | "medium" | "high";

export type LocalImpact = {
  /** True when the release notes mention a `Breaking` section. */
  hasBreakingChanges: boolean;
  /** True when the release notes mention config-key removals. */
  hasConfigMigration: boolean;
  /** True when the release notes mention auth/OAuth/token changes. */
  hasAuthChanges: boolean;
  /** True when the release notes mention plugin-related changes. */
  hasPluginChanges: boolean;
  /** Human-readable lines describing what to watch for. */
  notes: string[];
};

export type UpdateReviewResult = {
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Commits behind upstream for git installs; null for package installs. */
  gitBehind: number | null;
  /**
   * True when the registry was unreachable and there is no git signal.
   * The command cannot determine whether an update exists.
   */
  checkUnavailable: boolean;
  /** null when release notes could not be fetched (rate limit / network). */
  riskLevel: RiskLevel | null;
  releaseBody: string | null;
  changelogPreview: string | null;
  localImpact: LocalImpact;
  recommendation: "upgrade" | "review" | "up-to-date";
  recommendationReason: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const BREAKING_PATTERN = /###\s*breaking/i;
const CONFIG_PATTERN = /config.*remov|remov.*config.*key|doctor.*--fix|legacy.*config/i;
const AUTH_PATTERN = /\b(oauth|api[._-]?key|token|auth(?:entication|orization)?)\b/i;
const PLUGIN_PATTERN = /plugin/i;

/**
 * Derive risk level from release body heuristics.
 * Returns null when the body is unavailable — callers treat null as "unknown"
 * so a missing changelog never silently downgrades the risk estimate.
 */
function assessRisk(body: string | null): RiskLevel | null {
  if (!body) {
    return null;
  }
  if (BREAKING_PATTERN.test(body)) {
    return "high";
  }
  if (CONFIG_PATTERN.test(body) || AUTH_PATTERN.test(body)) {
    return "medium";
  }
  return "low";
}

/** Extract local-impact notes from release body. */
function extractLocalImpact(body: string | null, configSnapshot: ConfigFileSnapshot): LocalImpact {
  if (!body) {
    return {
      hasBreakingChanges: false,
      hasConfigMigration: false,
      hasAuthChanges: false,
      hasPluginChanges: false,
      notes: [],
    };
  }

  const hasBreakingChanges = BREAKING_PATTERN.test(body);
  const hasConfigMigration = CONFIG_PATTERN.test(body);
  const hasAuthChanges = AUTH_PATTERN.test(body);
  const hasPluginChanges = PLUGIN_PATTERN.test(body);

  const notes: string[] = [];

  if (hasBreakingChanges) {
    notes.push("Breaking changes detected — review the changelog before upgrading.");
  }
  if (hasConfigMigration) {
    notes.push(
      "Config key changes detected — run `openclaw doctor --fix` after upgrading to apply migrations.",
    );
  }
  if (hasAuthChanges && configSnapshot.valid) {
    notes.push(
      "Auth/OAuth changes detected — verify your provider profiles are still valid after upgrading.",
    );
  }
  if (hasPluginChanges) {
    notes.push("Plugin changes detected — plugins will be synced automatically during upgrade.");
  }

  if (notes.length === 0) {
    notes.push("No local-config action required.");
  }

  return {
    hasBreakingChanges,
    hasConfigMigration,
    hasAuthChanges,
    hasPluginChanges,
    notes,
  };
}

/** Map risk level to a coloured badge string. */
function formatRiskBadge(risk: RiskLevel): string {
  switch (risk) {
    case "low":
      return theme.success("🟢 Low");
    case "medium":
      return theme.warn("🟡 Medium");
    case "high":
      return theme.error("🔴 High");
  }
}

/** Fetch GitHub release body for a given version tag. */
async function fetchReleaseBody(version: string, timeoutMs: number): Promise<string | null> {
  const tag = `v${version}`;
  const url = `https://api.github.com/repos/openclaw/openclaw/releases/tags/${tag}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { body?: string | null };
    return data.body ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Truncate a long release body to a readable preview. */
function summariseBody(body: string | null, maxLines = 20): string | null {
  if (!body) {
    return null;
  }
  const lines = body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length <= maxLines) {
    return lines.join("\n");
  }
  return lines.slice(0, maxLines).join("\n") + `\n  … (${lines.length - maxLines} more lines)`;
}

// ── Command ──────────────────────────────────────────────────────────────────

export async function updateReviewCommand(opts: UpdateReviewOptions): Promise<void> {
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }

  const root = await resolveUpdateRoot();
  const [updateStatus, configSnapshot] = await Promise.all([
    checkUpdateStatus({
      root,
      timeoutMs: timeoutMs ?? 8000,
      fetchGit: true,
      includeRegistry: true,
    }),
    readConfigFileSnapshot(),
  ]);

  // Resolve the effective update channel so beta/dev users get the right target version.
  const configChannel: UpdateChannel | null = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config?.update?.channel)
    : null;
  const defaultChannel: UpdateChannel =
    updateStatus.installKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const effectiveChannel: UpdateChannel = configChannel ?? defaultChannel;

  // For stable channel, use the registry result we already have.
  // For beta/dev, resolve the channel-specific dist-tag version.
  let targetVersion: string | null;
  let resolvedTag: string = "latest";
  if (effectiveChannel === "stable") {
    targetVersion = updateStatus.registry?.latestVersion ?? null;
  } else {
    const resolved = await resolveNpmChannelTag({
      channel: effectiveChannel,
      timeoutMs: timeoutMs ?? 8000,
    });
    targetVersion = resolved.version;
    resolvedTag = resolved.tag;
  }

  const cmp = targetVersion ? compareSemverStrings(VERSION, targetVersion) : null;

  // Three distinct registry states — null means we couldn't check, not that we're current.
  const registryCheckState: "update-available" | "up-to-date" | "unavailable" =
    targetVersion == null
      ? "unavailable"
      : cmp != null && cmp < 0
        ? "update-available"
        : "up-to-date";

  // For git installs, check whether the local checkout is behind upstream.
  const gitBehind =
    updateStatus.installKind === "git" &&
    typeof updateStatus.git?.behind === "number" &&
    updateStatus.git.behind > 0
      ? updateStatus.git.behind
      : null;

  // If git fetch itself failed, we can't trust the behind count — treat as unknown.
  const gitFetchFailed =
    updateStatus.installKind === "git" && updateStatus.git?.fetchOk === false;

  // Detect downgrade scenario: installed version is *ahead* of the channel target.
  const isDowngrade = cmp != null && cmp > 0;

  // Registry truly unavailable (or git fetch failed) with no other signal.
  const checkUnavailable =
    (registryCheckState === "unavailable" && gitBehind === null && !gitFetchFailed) ||
    (gitFetchFailed && registryCheckState !== "update-available");

  const updateAvailable =
    registryCheckState === "update-available" || gitBehind !== null || isDowngrade;

  // Only fetch release notes when there is a *newer* npm version to score.
  // For git-behind-only cases the installed npm version's notes are stale/irrelevant.
  const releaseBody =
    registryCheckState === "update-available" && targetVersion
      ? await fetchReleaseBody(targetVersion, timeoutMs ?? 8000)
      : null;

  const riskLevel = assessRisk(releaseBody);
  const localImpact = extractLocalImpact(releaseBody, configSnapshot);

  // Recommendation logic
  let recommendation: UpdateReviewResult["recommendation"];
  let recommendationReason: string;

  if (checkUnavailable) {
    recommendation = "review";
    recommendationReason =
      "Registry unavailable — couldn't determine if an update exists. Check your connection.";
  } else if (isDowngrade) {
    recommendation = "review";
    recommendationReason =
      `Installed version (${VERSION}) is ahead of the ${resolvedTag} target (${targetVersion}) — this would be a downgrade.`;
  } else if (!updateAvailable) {
    recommendation = "up-to-date";
    recommendationReason = "You are on the latest version.";
  } else if (gitFetchFailed) {
    recommendation = "review";
    recommendationReason =
      "Git fetch failed — couldn't determine upstream status. Check your connection and retry.";
  } else if (gitBehind !== null && registryCheckState !== "update-available") {
    // Git checkout is behind upstream but npm version is current — can't score the pending commits.
    recommendation = "review";
    recommendationReason =
      `Git checkout is ${gitBehind} commit${gitBehind === 1 ? "" : "s"} behind upstream — run \`openclaw update\` to see what changed.`;
  } else if (riskLevel === null) {
    // Update available but release notes couldn't be fetched — don't assume safe.
    recommendation = "review";
    recommendationReason =
      "Release notes unavailable — inspect the changelog manually before upgrading.";
  } else if (riskLevel === "high") {
    recommendation = "review";
    recommendationReason = "Breaking changes present — read the changelog before upgrading.";
  } else if (riskLevel === "medium") {
    recommendation = "upgrade";
    recommendationReason =
      "Config or auth changes detected — run `openclaw doctor --fix` after upgrading.";
  } else {
    recommendation = "upgrade";
    recommendationReason = "Low-risk update — safe to upgrade now.";
  }

  const changelogPreview = summariseBody(releaseBody);

  const result: UpdateReviewResult = {
    installedVersion: VERSION,
    latestVersion: targetVersion,
    updateAvailable,
    checkUnavailable,
    gitBehind,
    riskLevel,
    releaseBody,
    changelogPreview,
    localImpact,
    recommendation,
    recommendationReason,
  };

  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }

  // ── Human-readable output ──────────────────────────────────────────────────

  defaultRuntime.log(theme.heading("OpenClaw update review"));
  defaultRuntime.log("");

  const tableWidth = getTerminalTableWidth();

  // Build the Update cell.
  let updateValue: string;
  if (checkUnavailable) {
    updateValue = theme.warn("unknown (check failed)");
  } else if (isDowngrade) {
    updateValue = theme.warn("downgrade");
  } else if (!updateAvailable) {
    updateValue = theme.success("up to date");
  } else if (gitFetchFailed) {
    updateValue = theme.warn("unknown (git fetch failed)");
  } else if (gitBehind !== null && registryCheckState !== "update-available") {
    updateValue = theme.warn(`git behind ${gitBehind}`);
  } else if (gitBehind !== null) {
    updateValue = theme.warn(`available · git behind ${gitBehind}`);
  } else {
    updateValue = theme.warn("available");
  }

  // Risk is only meaningful when we scored actual release notes.
  let riskValue: string;
  if (checkUnavailable || gitFetchFailed || (gitBehind !== null && registryCheckState !== "update-available")) {
    riskValue = theme.warn("unknown");
  } else if (!updateAvailable) {
    riskValue = theme.success("none");
  } else if (riskLevel !== null) {
    riskValue = formatRiskBadge(riskLevel);
  } else {
    riskValue = theme.warn("unknown");
  }

  const channelSuffix = resolvedTag !== "latest" ? ` (${resolvedTag})` : "";

  const rows = [
    { Item: "Installed", Value: VERSION },
    { Item: "Latest", Value: (targetVersion ?? theme.muted("unknown")) + channelSuffix },
    { Item: "Update", Value: updateValue },
    { Item: "Risk", Value: riskValue },
  ];

  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", minWidth: 20, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");

  if (!updateAvailable && !checkUnavailable && !isDowngrade) {
    return;
  }

  defaultRuntime.log(theme.heading("Your setup"));
  defaultRuntime.log("");
  for (const note of localImpact.notes) {
    defaultRuntime.log(`- ${note}`);
  }
  defaultRuntime.log("");

  if (changelogPreview) {
    defaultRuntime.log(theme.heading("What changed"));
    defaultRuntime.log("");
    for (const line of changelogPreview.split("\n")) {
      defaultRuntime.log(theme.muted(line));
    }
    defaultRuntime.log("");
  } else {
    defaultRuntime.log(
      theme.muted("Release notes unavailable (GitHub rate limit or network error)."),
    );
    defaultRuntime.log("");
  }

  const recIcon =
    recommendation === "upgrade"
      ? theme.success("✅")
      : recommendation === "review"
        ? theme.warn("⚠️ ")
        : theme.success("✓");

  const recLabel =
    recommendation === "upgrade"
      ? "Upgrade now"
      : recommendation === "review"
        ? "Review before upgrading"
        : "Up to date";

  defaultRuntime.log(theme.heading("Recommendation:"));
  defaultRuntime.log(`  ${recIcon} ${recLabel}`);
  defaultRuntime.log(`  ${theme.muted(recommendationReason)}`);
  defaultRuntime.log("");

  if (recommendation !== "up-to-date") {
    defaultRuntime.log(`  ${theme.muted("To upgrade:")} ${formatCliCommand("openclaw update")}`);
    defaultRuntime.log("");
  }
}
