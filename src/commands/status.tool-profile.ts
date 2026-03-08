export function formatStatusToolProfileValue(
  profile: string | null | undefined,
): string | null {
  if (!profile) {
    return null;
  }
  if (profile === "messaging") {
    return `${profile} · intentionally narrow by design; use \`tools.profile: "full"\` for broader command/control access`;
  }
  if (profile === "full") {
    return `${profile} · broadest command/control surface`;
  }
  return profile;
}
