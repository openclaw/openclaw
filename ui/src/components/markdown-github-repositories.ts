export type MarkdownGitHubRepository = { owner: string; repo: string; host?: string };
export type MarkdownGitHubRepositoryAliases = {
  aliases: readonly string[];
} & (MarkdownGitHubRepository | { owner?: never; repo?: never });
/** Omitted host is the established public-GitHub context; supplied hosts are verified origins. */
export function markdownGitHubHost(repository: MarkdownGitHubRepository): string | undefined {
  if (repository.host === undefined) {
    return "github.com";
  }
  try {
    const url = new URL(`https://${repository.host}`);
    return url.host.toLowerCase() === repository.host.toLowerCase() &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.host.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

export type MarkdownGitHubAliases = readonly (readonly [string, MarkdownGitHubRepository | null])[];

/** Unknown origins participate in collisions: a hidden project must not pick a public namesake. */
export function markdownGitHubAliases(
  repositories: readonly MarkdownGitHubRepositoryAliases[] = [],
  current?: MarkdownGitHubRepository | null,
): MarkdownGitHubAliases {
  const aliases = new Map<string, MarkdownGitHubRepository | null>();
  for (const entry of [...repositories, ...(current ? [{ ...current, aliases: [] }] : [])]) {
    const host = entry.owner && entry.repo ? markdownGitHubHost(entry) : undefined;
    const repository =
      entry.owner && entry.repo && host
        ? {
            owner: entry.owner.toLowerCase(),
            repo: entry.repo.toLowerCase(),
            ...(entry.host !== undefined ? { host } : {}),
          }
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
          (previous?.owner === repository?.owner &&
            previous?.repo === repository?.repo &&
            (previous && markdownGitHubHost(previous)) ===
              (repository && markdownGitHubHost(repository)))
          ? repository
          : null,
      );
    }
  }
  return [...aliases].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Preview classification consumes every admitted origin, including colliding aliases. */
export function markdownGitHubHosts(
  repositories: readonly MarkdownGitHubRepositoryAliases[] = [],
  current?: MarkdownGitHubRepository | null,
): string[] {
  return [
    ...new Set(
      [...repositories, ...(current ? [current] : [])].flatMap((repository) => {
        const host =
          repository.owner && repository.repo ? markdownGitHubHost(repository) : undefined;
        return host ? [host] : [];
      }),
    ),
  ].toSorted();
}

export function markdownGitHubAliasSignature(
  repositories?: readonly MarkdownGitHubRepositoryAliases[],
  current?: MarkdownGitHubRepository | null,
): string {
  return JSON.stringify([
    markdownGitHubAliases(repositories, current),
    markdownGitHubHosts(repositories, current),
    [...(repositories ?? []), ...(current ? [current] : [])]
      .flatMap((repository) =>
        repository.owner && repository.repo
          ? [
              JSON.stringify([
                repository.owner.toLowerCase(),
                repository.repo.toLowerCase(),
                markdownGitHubHost(repository) ?? null,
              ]),
            ]
          : [],
      )
      .toSorted(),
  ]);
}
