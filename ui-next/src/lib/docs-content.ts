import { loader } from "fumadocs-core/source";
import type { MetaData, PageData } from "fumadocs-core/source";
import docsDates from "./docs-dates.generated.json";

// Build-time import of all operator1 docs as raw markdown strings
const rawDocs = import.meta.glob("../../../docs/operator1/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

// ── Custom page data (extends fumadocs PageData with raw content) ────────────
export interface DocsPageData extends PageData {
  content: string;
  /** ISO date string from frontmatter `updated:` field, if present */
  updated?: string;
}

// ── Category / ordering definition ──────────────────────────────────────────
// Each entry maps a virtual folder name → { label, ordered page slugs }
const CATEGORY_ORDER: { id: string; label: string; pages: string[] }[] = [
  { id: "overview", label: "Overview", pages: ["index"] },
  {
    id: "architecture",
    label: "Architecture",
    pages: ["architecture", "agent-hierarchy", "delegation", "gateway-patterns"],
  },
  {
    id: "configuration",
    label: "Configuration",
    pages: ["configuration", "agent-configs", "memory-system"],
  },
  {
    id: "operations",
    label: "Operations",
    pages: ["rpc", "orchestration", "deployment", "channels", "spawning", "mcp"],
  },
  {
    id: "interface",
    label: "Interface",
    pages: ["agents", "visualize", "memory", "chat"],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractTitle(content: string): string {
  const fmMatch = content.match(/^---\s*\n[\s\S]*?title:\s*"?([^"\n]+)"?\s*\n[\s\S]*?---/);
  if (fmMatch) {
    return fmMatch[1].trim();
  }
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  return "Untitled";
}

function extractDescription(content: string): string | undefined {
  const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*"?([^"\n]+)"?\s*\n[\s\S]*?---/);
  return fmMatch ? fmMatch[1].trim() : undefined;
}

function extractUpdated(content: string): string | undefined {
  const fmMatch = content.match(/^---\s*\n[\s\S]*?updated:\s*"?([^"\n]+)"?\s*\n[\s\S]*?---/);
  return fmMatch ? fmMatch[1].trim() : undefined;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
}

// ── Build slug→virtualPath lookup from CATEGORY_ORDER ──────────────────────
// Maps e.g. "architecture" → "architecture/overview", "agent-hierarchy" → "architecture/agent-hierarchy"
const SLUG_TO_DOC_PATH: Record<string, string> = {};
for (const cat of CATEGORY_ORDER) {
  for (const slug of cat.pages) {
    if (cat.id === "overview") {
      SLUG_TO_DOC_PATH[slug] = "";
    } else {
      const virtualName = slug === cat.id ? "overview" : slug;
      SLUG_TO_DOC_PATH[slug] = `${cat.id}/${virtualName}`;
    }
  }
}

/**
 * Rewrite internal links in operator1 docs.
 *
 * 1. /operator1/<slug> → /docs/<category>/<virtualName>
 *    (Mintlify root-relative links referencing operator1 docs)
 * 2. /<openclaw-path> → /openclaw-docs/<openclaw-path>
 *    (Links to OpenClaw docs like /gateway/configuration, /concepts/multi-agent)
 */
function rewriteOperator1Links(content: string): string {
  let out = content;

  // Rewrite ](/operator1/<slug>) to the correct /docs/ path
  out = out.replace(
    /\]\(\/operator1\/([^)#]+)(#[^)]*)?\)/g,
    (_match, slug: string, anchor = "") => {
      const docPath = SLUG_TO_DOC_PATH[slug];
      if (docPath !== undefined) {
        return `](/docs/${docPath}${anchor})`;
      }
      // Unknown slug — leave as /docs/<slug> (best effort)
      return `](/docs/${slug}${anchor})`;
    },
  );

  // Rewrite ](/docs/...) links that already use the /docs prefix — leave as-is
  // (they're correct for ui-next routing)

  // Rewrite other root-relative links that reference OpenClaw docs
  // e.g. ](/gateway/configuration) → ](/openclaw-docs/gateway/configuration)
  // But NOT ](/docs/...) which are already operator1 doc links
  // And NOT external URLs
  const openclawDocPrefixes = [
    "start",
    "concepts",
    "install",
    "gateway",
    "channels",
    "providers",
    "tools",
    "cli",
    "platforms",
    "plugins",
    "automation",
    "nodes",
    "help",
    "web",
    "security",
    "reference",
    "debug",
    "diagnostics",
  ];
  const prefixPattern = openclawDocPrefixes.join("|");
  const openclawRe = new RegExp(`\\]\\(\\/(?:${prefixPattern})\\/([^)]+)\\)`, "g");
  out = out.replace(openclawRe, (match) => {
    // match is e.g. "](/gateway/configuration)"
    // Insert /openclaw-docs prefix
    return match.replace("](/", "](/openclaw-docs/");
  });

  // Rewrite /images/ → /openclaw-docs/images/ (shared image assets in docs/images/)
  out = out.replace(/\]\(\/images\//g, "](/openclaw-docs/images/");

  return out;
}

// slug → raw content string (frontmatter stripped)
const rawBySlug: Record<string, string> = {};
for (const [path, raw] of Object.entries(rawDocs)) {
  const slug = path.split("/").pop()?.replace(/\.md$/, "");
  if (slug) {
    rawBySlug[slug] = raw;
  }
}

// ── Build VirtualFile[] for fumadocs-core loader ─────────────────────────────
// The virtual path determines the URL slug, not the real filesystem path.
// index.md → path='index.md'  → url='/docs'
// architecture.md → path='architecture/overview.md' → url='/docs/architecture/overview'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const files: any[] = [];

// Root meta — defines top-level sections in sidebar order
files.push({
  type: "meta",
  path: "meta.json",
  data: {
    title: "Operator1 Docs",
    pages: ["index", "architecture", "configuration", "operations", "interface"],
  } satisfies MetaData,
});

for (const cat of CATEGORY_ORDER) {
  if (cat.id === "overview") {
    // index page lives at root (no subfolder)
    const raw = rawBySlug["index"] ?? "";
    files.push({
      type: "page",
      path: "index.md",
      data: {
        title: extractTitle(raw) || "Overview",
        description: extractDescription(raw),
        content: rewriteOperator1Links(stripFrontmatter(raw)),
        updated: extractUpdated(raw) ?? (docsDates as Record<string, string>)["index"],
      } satisfies DocsPageData,
    });
  } else {
    // Folder meta — defines page order within this section
    files.push({
      type: "meta",
      path: `${cat.id}/meta.json`,
      data: {
        title: cat.label,
        pages: cat.pages.map((slug) => {
          // The first page in architecture is named 'architecture' in the
          // filesystem but we map it to 'overview' inside the folder.
          if (slug === cat.id) {
            return "overview";
          }
          return slug;
        }),
      } satisfies MetaData,
    });

    for (const slug of cat.pages) {
      const raw = rawBySlug[slug] ?? "";
      // Map e.g. 'architecture' → 'architecture/overview.md'
      const virtualName = slug === cat.id ? "overview" : slug;
      files.push({
        type: "page",
        path: `${cat.id}/${virtualName}.md`,
        data: {
          title: extractTitle(raw) || virtualName,
          description: extractDescription(raw),
          content: rewriteOperator1Links(stripFrontmatter(raw)),
          updated: extractUpdated(raw) ?? (docsDates as Record<string, string>)[slug],
        } satisfies DocsPageData,
      });
    }
  }
}

// ── Source loader ─────────────────────────────────────────────────────────────
export const docsSource = loader({
  baseUrl: "/docs",
  source: { files },
});

// ── Convenience re-exports for the docs page ─────────────────────────────────

/** Flat ordered list of all pages (for prev/next navigation) */
export function getAllPages() {
  return docsSource.getPages();
}

/** Look up a page by its slug array, e.g. [] → index, ['architecture','overview'] */
export function getDocPage(slugs?: string[]) {
  return docsSource.getPage(slugs);
}

/** The page tree for the sidebar */
export const docsPageTree = docsSource.pageTree;
