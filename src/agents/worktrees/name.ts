const WORKTREE_NAME_MAX_LENGTH = 64;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

export function appendNameOrdinal(name: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  return `${name.slice(0, WORKTREE_NAME_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/** Converts a short human-readable title into a valid managed-worktree name. */
export function slugifyWorktreeTitle(title: string): string | undefined {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= WORKTREE_NAME_MAX_LENGTH) {
    return slug || undefined;
  }
  const truncated = slug.slice(0, WORKTREE_NAME_MAX_LENGTH);
  const wordBoundary = truncated.lastIndexOf("-");
  return wordBoundary > 0 ? truncated.slice(0, wordBoundary) : truncated;
}
