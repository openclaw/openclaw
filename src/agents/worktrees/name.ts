const WORKTREE_NAME_MAX_LENGTH = 64;
export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateName(name: string): string {
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

function appendNameSuffix(name: string, value: string): string {
  const suffix = `-${value}`;
  return `${name.slice(0, WORKTREE_NAME_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

export function appendNameOrdinal(name: string, ordinal: number): string {
  return appendNameSuffix(name, String(ordinal));
}

const WORKTREE_ID_SUFFIX_LENGTH = 6;

/**
 * Ends a generated name with the start of its worktree's random ID. Branches are named
 * `openclaw/<name>` and outlive their checkouts on GitHub, so a readable name alone can
 * collide with an old remote branch; the ID makes that practically impossible without a lookup.
 */
export function appendWorktreeIdSuffix(name: string, worktreeId: string): string {
  const suffix = worktreeId
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase()
    .slice(0, WORKTREE_ID_SUFFIX_LENGTH);
  return suffix ? appendNameSuffix(name, suffix) : name;
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
