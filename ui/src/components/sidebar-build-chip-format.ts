import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";

const BRANCH_DISPLAY_LENGTH = 14;
function formatNonReleaseGitIdentity(info: ControlUiBuildInfo): string | null {
  if (info.release || !info.commit) {
    return null;
  }
  const branch = info.branch && info.branch !== "main" ? info.branch : "git";
  const displayBranch =
    branch.length > BRANCH_DISPLAY_LENGTH
      ? `${truncateUtf16Safe(branch, BRANCH_DISPLAY_LENGTH)}…`
      : branch;
  const commit = `${info.commit.slice(0, 7)}${info.dirty === true ? "*" : ""}`;
  return `${displayBranch}@${commit}`;
}

export function formatSidebarBuildSubtitle(info: ControlUiBuildInfo): string | null {
  const gitIdentity = formatNonReleaseGitIdentity(info);
  if (!gitIdentity) {
    return null;
  }
  const commitAt = info.commitAt ? Date.parse(info.commitAt) : Number.NaN;
  return Number.isFinite(commitAt)
    ? `${gitIdentity} · ${formatRelativeTimestamp(commitAt)}`
    : gitIdentity;
}

export function formatSettingsBuildLabel(
  info: ControlUiBuildInfo,
  gatewayVersion: string | null,
): string | null {
  const version = info.version ?? gatewayVersion;
  const gitIdentity = formatNonReleaseGitIdentity(info);
  if (!gitIdentity) {
    return version;
  }
  return [version, gitIdentity].filter((value): value is string => Boolean(value)).join(" · ");
}
