export function formatGlobalStatusToolProfileValue(
  profile: string | null | undefined,
): string | null {
  if (!profile) {
    return null;
  }
  if (profile === "messaging") {
    return `${profile} · global config baseline; intentionally narrow by design. Per-agent/provider overrides may still differ. Use \`tools.profile: "full"\` for broader global command/control access.`;
  }
  if (profile === "full") {
    return `${profile} · broadest global command/control baseline`;
  }
  return profile;
}
