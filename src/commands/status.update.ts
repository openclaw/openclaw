import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import { formatInstallOwnerMessage } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type UpdateCheckResult,
  type UpdateInstallIdentity,
} from "../infra/update-check.js";
import { VERSION } from "../version.js";

/** Chooses a registry tag only after the status check has identified the install. */
export function resolveStatusRegistryUpdateChannel(
  params: UpdateInstallIdentity & {
    configChannel?: UpdateChannel | null;
  },
): UpdateChannel {
  return resolveEffectiveUpdateChannel({
    configChannel: params.configChannel,
    currentVersion: VERSION,
    installKind: params.installKind,
    git: params.git,
  }).channel;
}

export async function getUpdateCheckResult(params: {
  timeoutMs: number;
  fetchGit: boolean;
  includeRegistry: boolean;
  updateConfigChannel?: string | null;
}): Promise<UpdateCheckResult> {
  const configChannel = normalizeUpdateChannel(params.updateConfigChannel);
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  let gitProbeTimeoutMs: number | undefined;
  const update = await checkUpdateStatus({
    root,
    timeoutMs: params.timeoutMs,
    fetchGit: params.fetchGit,
    includeRegistry: params.includeRegistry,
    onGitProbeTimeout: (timeoutMs) => {
      gitProbeTimeoutMs ??= timeoutMs;
    },
    resolveRegistryChannel: ({ installKind, git }) =>
      resolveStatusRegistryUpdateChannel({
        configChannel,
        installKind,
        git,
      }),
  }).catch((error: unknown): UpdateCheckResult => ({
    root,
    installKind: "unknown",
    packageManager: "unknown",
    error: { status: "failed", message: sanitizeTerminalText(formatErrorMessage(error)) },
  }));
  if (gitProbeTimeoutMs !== undefined) {
    update.error = {
      status: "unknown",
      timeoutMs: gitProbeTimeoutMs,
      message: `git check did not finish within ${gitProbeTimeoutMs / 1000} s (slow host)`,
    };
  } else if (update.git?.error) {
    update.error = { status: "failed", message: sanitizeTerminalText(update.git.error) };
  }
  if (update.installKind === "git" && update.git && !params.fetchGit) {
    const stale = await import("../infra/update-run-ledger.js")
      .then(({ getLatestUpdateFetchFailure }) => getLatestUpdateFetchFailure())
      .catch(() => undefined);
    if (stale) {
      update.git = { ...update.git, stale, countsCached: true };
    }
  }
  return update;
}

export function resolveUpdateAvailability(update: UpdateCheckResult) {
  const latestVersion =
    update.installKind === "host" || update.installKind === "immutable"
      ? null
      : (update.registry?.latestVersion ?? null);
  const registryCmp = latestVersion ? compareSemverStrings(VERSION, latestVersion) : null;
  const hasRegistryUpdate = !update.error && registryCmp != null && registryCmp < 0;
  const gitBehind =
    !update.error && update.installKind === "git" && typeof update.git?.behind === "number"
      ? update.git.behind
      : null;
  const hasGitUpdate = gitBehind != null && gitBehind > 0;

  return {
    available: hasGitUpdate || hasRegistryUpdate,
    hasGitUpdate,
    hasRegistryUpdate,
    latestVersion: hasRegistryUpdate ? latestVersion : null,
    gitBehind,
  };
}

export function formatUpdateAvailableHint(update: UpdateCheckResult): string | null {
  const availability = resolveUpdateAvailability(update);
  if (!availability.available) {
    return null;
  }

  const details: string[] = [];
  if (availability.hasGitUpdate && availability.gitBehind != null) {
    details.push(
      `git behind ${availability.gitBehind}${update.git?.countsCached ? " (cached)" : ""}`,
    );
  }
  if (availability.hasRegistryUpdate && availability.latestVersion) {
    details.push(`npm ${availability.latestVersion}`);
  }
  const suffix = details.length > 0 ? ` (${details.join(" · ")})` : "";
  return `Update available${suffix}. Run: ${formatCliCommand("openclaw update")}`;
}

export function formatUpdateOneLiner(update: UpdateCheckResult): string {
  if (update.installKind === "host" && update.installOwner) {
    return `Update: ${formatInstallOwnerMessage(update.installOwner)}`;
  }
  if (update.error) {
    return `Update: update status ${update.error.status}: ${update.error.message}; run ${formatCliCommand("openclaw update status")}`;
  }
  if (update.installKind === "immutable") {
    const install = update.immutable;
    return install
      ? `Update: immutable ${install.currentSha.slice(0, 12)}${install.prepared ? ` · prepared ${install.prepared.sha.slice(0, 12)}` : ""} · activation unavailable`
      : "Update: immutable · installation facts unavailable";
  }
  const parts: string[] = [];

  if (update.installKind === "git" && update.git) {
    const branch = update.git.branch ? `git ${update.git.branch}` : "git";
    parts.push(branch);
    if (update.git.upstream) {
      parts.push(`↔ ${update.git.upstream}`);
    }
    if (update.git.dirty === true) {
      parts.push("dirty");
    }
    if (update.git.stale) {
      const { failedAtMs, detail } = update.git.stale;
      parts.push(
        `update check stale: last update fetch failed ${formatTimeAgo(Math.max(0, Date.now() - failedAtMs))} (${detail})`,
      );
      if (update.git.behind != null && update.git.ahead != null) {
        parts.push(`cached: ahead ${update.git.ahead}, behind ${update.git.behind}`);
      }
    } else if (update.git.behind != null && update.git.ahead != null) {
      if (update.git.behind === 0 && update.git.ahead === 0) {
        parts.push("up to date");
      } else if (update.git.behind > 0 && update.git.ahead === 0) {
        parts.push(`behind ${update.git.behind}`);
      } else if (update.git.behind === 0 && update.git.ahead > 0) {
        parts.push(`ahead ${update.git.ahead}`);
      } else if (update.git.behind > 0 && update.git.ahead > 0) {
        parts.push(`diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`);
      }
    }
    if (update.git.fetchOk === false) {
      parts.push("fetch failed");
    }
    // A checkout that pulled but never rebuilt keeps executing the previous dist,
    // so report the built commit rather than letting HEAD imply what is running.
    if (update.git.builtSha && update.git.sha && update.git.builtSha !== update.git.sha) {
      parts.push(`stale build (running ${update.git.builtSha.slice(0, 8)}, run pnpm build)`);
    }
  } else {
    parts.push(update.packageManager !== "unknown" ? update.packageManager : "pkg");
  }

  const registryLabel =
    update.registry?.tag && update.registry.tag !== "latest"
      ? `npm ${update.registry.tag}`
      : "npm latest";
  if (update.registry?.latestVersion) {
    const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
    if (cmp === 0) {
      if (update.installKind !== "git") {
        parts.push("up to date");
      }
      // Git installs still show registry latest, but git ahead/behind remains the primary state.
      parts.push(`${registryLabel} ${update.registry.latestVersion}`);
    } else if (cmp != null && cmp < 0) {
      parts.push(
        update.registry.tag && update.registry.tag !== "latest"
          ? `${registryLabel} update ${update.registry.latestVersion}`
          : `npm update ${update.registry.latestVersion}`,
      );
    } else {
      parts.push(
        update.registry.tag === "extended-stable"
          ? `ahead of extended-stable (${update.registry.latestVersion})`
          : `${registryLabel} ${update.registry.latestVersion} (local newer)`,
      );
    }
  } else if (update.registry?.error) {
    const errors = new Map([
      ["unsupported_git_channel", "extended-stable requires a package install"],
      ["selector_missing", "npm extended-stable selector missing"],
      ["selector_query_failed", "npm extended-stable query failed"],
      ["exact_package_mismatch", "npm extended-stable exact package verification failed"],
    ]);
    parts.push(errors.get(update.registry.reason ?? "") ?? `${registryLabel} unknown`);
  }

  if (update.deps?.status === "ok" || update.deps?.status === "missing") {
    parts.push(`deps ${update.deps.status}`);
  }
  return `Update: ${parts.join(" · ")}`;
}
