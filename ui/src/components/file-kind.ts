// Shared glyph categories for file previews and Markdown file links.
export type FileKind =
  | "skill"
  | "markdown"
  | "component"
  | "package"
  | "data"
  | "shell"
  | "image"
  | "code"
  | "file";

// Well-known filenames outrank their extension: package.json is a manifest
// first and JSON second, and lockfiles carry no useful extension at all.
const FILE_KIND_BY_NAME: Record<string, FileKind> = {
  "bun.lock": "package",
  "package-lock.json": "package",
  "package.json": "package",
  "pnpm-lock.yaml": "package",
  "skill.md": "skill",
  "yarn.lock": "package",
};

const FILE_EXTENSIONS_BY_KIND: ReadonlyArray<readonly [FileKind, readonly string[]]> = [
  ["component", ["astro", "jsx", "svelte", "tsx", "vue"]],
  [
    "data",
    ["cfg", "conf", "ini", "json", "jsonc", "lock", "plist", "proto", "toml", "xml", "yaml", "yml"],
  ],
  ["image", ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]],
  ["markdown", ["markdown", "md", "mdx"]],
  ["shell", ["bash", "fish", "sh", "zsh"]],
  [
    "code",
    [
      "c",
      "cc",
      "cjs",
      "cpp",
      "cs",
      "css",
      "cts",
      "go",
      "h",
      "hpp",
      "htm",
      "html",
      "java",
      "js",
      "kt",
      "kts",
      "less",
      "mjs",
      "mts",
      "php",
      "py",
      "rb",
      "rs",
      "scss",
      "sql",
      "swift",
      "ts",
    ],
  ],
];
const FILE_KIND_BY_EXTENSION = new Map(
  FILE_EXTENSIONS_BY_KIND.flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind] as const),
  ),
);

// Windows paths reach chat verbatim, so both separators split segments.
const PATH_SEPARATOR_RE = /[\\/]/;

export function fileKindForPath(path: string): FileKind {
  const name = (path.split(PATH_SEPARATOR_RE).at(-1) ?? path).toLowerCase();
  if (Object.hasOwn(FILE_KIND_BY_NAME, name)) {
    return FILE_KIND_BY_NAME[name]!;
  }
  // Index 0 means a dotfile (".gitignore"), which has a leading dot rather than
  // an extension; it falls through to the generic document kind.
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return FILE_KIND_BY_EXTENSION.get(extension) ?? "file";
}

type SuffixTrieNode = {
  pathCount: number;
  children: Map<string, SuffixTrieNode>;
};

// A reversed-segment trie keeps suffix resolution linear in total path length.
function insertReversedSegments(root: SuffixTrieNode, segments: readonly string[]): void {
  let node = root;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    let child = node.children.get(segment);
    if (!child) {
      child = { pathCount: 0, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
    node.pathCount += 1;
  }
}

function shortestUniqueSuffixDepth(root: SuffixTrieNode, segments: readonly string[]): number {
  let node = root;
  for (let depth = 1; depth <= segments.length; depth++) {
    node = node.children.get(segments[segments.length - depth]!) ?? node;
    if (node.pathCount === 1 || depth === segments.length) {
      return depth;
    }
  }
  return segments.length;
}

/**
 * Shortest unambiguous label per path: the basename alone when it is unique
 * among the supplied paths, otherwise the smallest trailing run of segments
 * that no other path shares. Callers pass every path rendered together so two
 * `Button.tsx` links from different directories stay distinguishable.
 */
export function shortestFileLabels(paths: readonly string[]): Map<string, string> {
  const unique = [...new Set(paths)];
  // The leading empty segment distinguishes absolute paths from matching relative paths.
  const segmentsByPath = new Map(unique.map((path) => [path, path.split(PATH_SEPARATOR_RE)]));
  const suffixTrie: SuffixTrieNode = { pathCount: 0, children: new Map() };
  for (const segments of segmentsByPath.values()) {
    insertReversedSegments(suffixTrie, segments);
  }
  const labels = new Map<string, string>();
  for (const [path, segments] of segmentsByPath) {
    const depth = shortestUniqueSuffixDepth(suffixTrie, segments);
    // Render the suffix with the separator the path itself used so a Windows
    // path never reads as a POSIX one.
    labels.set(path, segments.slice(-depth).join(path.includes("\\") ? "\\" : "/"));
  }
  return labels;
}
