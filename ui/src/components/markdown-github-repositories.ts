export type MarkdownGitHubRepository = { owner: string; repo: string };
export type MarkdownGitHubRepositoryAliases = {
  aliases: readonly string[];
} & (MarkdownGitHubRepository | { owner?: never; repo?: never });
export type MarkdownGitHubAliases = readonly (readonly [string, MarkdownGitHubRepository | null])[];

/** Unknown origins participate in collisions: a hidden project must not pick a public namesake. */
export function markdownGitHubAliases(
  repositories: readonly MarkdownGitHubRepositoryAliases[] = [],
  current?: MarkdownGitHubRepository | null,
): MarkdownGitHubAliases {
  const aliases = new Map<string, MarkdownGitHubRepository | null>();
  for (const entry of [...repositories, ...(current ? [{ ...current, aliases: [] }] : [])]) {
    const repository =
      entry.owner && entry.repo
        ? { owner: entry.owner.toLowerCase(), repo: entry.repo.toLowerCase() }
        : null;
    for (const name of [...entry.aliases, ...(repository ? [repository.repo] : [])]) {
      const alias = name.trim().toLowerCase();
      if (!alias) {
        continue;
      }
      const previous = aliases.get(alias);
      aliases.set(
        alias,
        previous === undefined ||
          (previous?.owner === repository?.owner && previous?.repo === repository?.repo)
          ? repository
          : null,
      );
    }
  }
  return [...aliases].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function markdownGitHubAliasSignature(
  repositories?: readonly MarkdownGitHubRepositoryAliases[],
  current?: MarkdownGitHubRepository | null,
): string {
  return JSON.stringify(markdownGitHubAliases(repositories, current));
}
