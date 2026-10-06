import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type RecentPlaceSource = {
  execCwd?: unknown;
  execNode?: unknown;
  worktree?: { repoRoot?: unknown } | null;
};

type RecentPlace = {
  folder: string;
};

export function recentPlaces(
  rows: readonly RecentPlaceSource[],
  opts: {
    workspace: string;
    allowGatewayFolder: (folder: string) => boolean;
  },
): RecentPlace[] {
  const seen = new Set<string>();
  const places: RecentPlace[] = [];

  for (const row of rows) {
    const folder =
      normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
    const execNode = normalizeOptionalString(row.execNode);
    if (!folder || execNode || folder === opts.workspace || !opts.allowGatewayFolder(folder)) {
      continue;
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    places.push({ folder });
    if (places.length >= 4) {
      break;
    }
  }
  return places;
}

export type { RecentPlaceSource };
