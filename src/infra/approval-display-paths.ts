/** Formats user-home paths compactly for approval prompts without normalizing unsafe paths. */
export function formatApprovalDisplayPath(value: string): string {
  const normalized = value.trim();
  if (!normalized || hasRelativePathSegment(normalized)) {
    return normalized;
  }

  const homeMatch =
    normalized.match(/^\/(?:home|Users)\/([^/]+)(.*)$/) ??
    normalized.match(/^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)(.*)$/i);
  // Display-only compaction leaves the original path available for approval matching.
  return homeMatch && isSafeHomeSegment(homeMatch[1])
    ? `~${(homeMatch[2] ?? "").replaceAll("\\", "/")}`
    : normalized;
}

function isSafeHomeSegment(segment: string | undefined): boolean {
  return segment !== undefined && segment !== "." && segment !== "..";
}

function hasRelativePathSegment(value: string): boolean {
  // Do not compact paths containing `.` or `..`; hiding those segments would make approval prompts
  // less precise than the path that will actually be evaluated.
  return /(^|[\\/])\.{1,2}(?=[\\/]|$)/.test(value);
}
