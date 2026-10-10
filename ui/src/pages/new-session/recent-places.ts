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
  const folders = new Set<string>();

  for (const row of rows) {
    const folder =
      normalizeOptionalString(row.execCwd) ?? normalizeOptionalString(row.worktree?.repoRoot);
    const execNode = normalizeOptionalString(row.execNode);
    if (!folder || execNode || folder === opts.workspace || !opts.allowGatewayFolder(folder)) {
      continue;
    }
    folders.add(folder);
    if (folders.size >= 4) {
      break;
    }
  }
  return Array.from(folders, (folder) => ({ folder }));
}

export type { RecentPlaceSource };
