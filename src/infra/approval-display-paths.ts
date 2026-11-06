/** Formats user-home paths compactly for approval prompts without normalizing unsafe paths. */
export function formatApprovalDisplayPath(value: string): string {
  const normalized = value.trim();
  // Do not compact paths containing `.` or `..`; hiding those segments would make approval prompts
  // less precise than the path that will actually be evaluated.
  if (!normalized || /(^|[\\/])\.{1,2}(?=[\\/]|$)/.test(normalized)) {
    return normalized;
  }

  const homeMatch =
    normalized.match(/^\/(?:home|Users)\/([^/]+)(.*)$/) ??
    normalized.match(/^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)(.*)$/i);
  // Display-only compaction leaves the original path available for approval matching.
  const homeSegment = homeMatch?.[1];
  return homeMatch && homeSegment !== undefined && homeSegment !== "." && homeSegment !== ".."
    ? `~${(homeMatch[2] ?? "").replaceAll("\\", "/")}`
    : normalized;
}
