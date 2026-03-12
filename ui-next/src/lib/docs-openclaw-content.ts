import { loader } from "fumadocs-core/source";
import type { MetaData } from "fumadocs-core/source";
import type { DocsPageData } from "./docs-content";

// Eager-load all English OpenClaw docs (excluding i18n and operator1)
const rawDocs = import.meta.glob(
  [
    "../../../docs/**/*.md",
    "!../../../docs/zh-CN/**",
    "!../../../docs/ja-JP/**",
    "!../../../docs/operator1/**",
  ],
  { eager: true, query: "?raw", import: "default" },
);

// ── Folder label + sidebar order ──────────────────────────────────────────────
const FOLDER_META: { id: string; label: string }[] = [
  { id: "_root", label: "General" },
  { id: "start", label: "Getting Started" },
  { id: "concepts", label: "Concepts" },
  { id: "install", label: "Installation" },
  { id: "gateway", label: "Gateway" },
  { id: "channels", label: "Channels" },
  { id: "providers", label: "Providers" },
  { id: "tools", label: "Tools" },
  { id: "cli", label: "CLI" },
  { id: "platforms", label: "Platforms" },
  { id: "plugins", label: "Plugins" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "help", label: "Help" },
  { id: "web", label: "Web" },
  { id: "security", label: "Security" },
  { id: "reference", label: "Reference" },
  { id: "debug", label: "Debug" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "design", label: "Design" },
  { id: "refactor", label: "Refactor" },
  { id: "experiments", label: "Experiments" },
];

const FOLDER_LABEL: Record<string, string> = Object.fromEntries(
  FOLDER_META.map((f) => [f.id, f.label]),
);
const FOLDER_ORDER: Record<string, number> = Object.fromEntries(
  FOLDER_META.map((f, i) => [f.id, i]),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTitle(content: string, fallback: string): string {
  const fmMatch = content.match(/^---\s*\n[\s\S]*?title:\s*"?([^"\n]+)"?\s*\n[\s\S]*?---/);
  if (fmMatch) {
    return fmMatch[1].trim();
  }
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  return fallback;
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

/**
 * Convert Mintlify-specific JSX/HTML components into standard markdown.
 * react-markdown (without rehype-raw) strips raw HTML, so these would
 * otherwise render as literal text or vanish entirely.
 */
function sanitizeMintlifyContent(content: string): string {
  let out = content;

  // ── Remove Mintlify image blocks (logo images with dark/light variants) ──
  // These reference /assets/* paths that don't exist in ui-next
  out = out.replace(/<p\s+align="center">\s*<img[\s\S]*?<\/p>/g, "");

  // ── Inline HTML: <p align="center"><strong>...</strong></p> → bold paragraph ──
  out = out.replace(
    /<p\s+align="center">\s*<strong>([\s\S]*?)<\/strong>(?:<br\s*\/?>)?\s*([\s\S]*?)<\/p>/g,
    (_match, bold, rest) => {
      const text = `**${bold.trim()}**`;
      const extra = rest.trim();
      return extra ? `${text}\n${extra}` : text;
    },
  );

  // ── Remaining <p align="center"><img ...></p> → markdown image ──
  out = out.replace(
    /<p\s+align="center">\s*<img\s+src="([^"]+)"\s+alt="([^"]*)"[^/]*\/?\s*>\s*<\/p>/g,
    "![$2]($1)",
  );

  // ── <Card title="..." href="...">content</Card> → linked list item ──
  out = out.replace(
    /<Card\s+title="([^"]+)"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/Card>/g,
    (_match, title, href, body) => {
      const desc = body.trim();
      return desc ? `- **[${title}](${href})** — ${desc}` : `- **[${title}](${href})**`;
    },
  );

  // ── <Card title="..." icon="...">content</Card> (no href) → bold list item ──
  out = out.replace(/<Card\s+title="([^"]+)"[^>]*>([\s\S]*?)<\/Card>/g, (_match, title, body) => {
    const desc = body.trim();
    return desc ? `- **${title}** — ${desc}` : `- **${title}**`;
  });

  // ── <Columns>...</Columns> and <CardGroup ...>...</CardGroup> → unwrap ──
  out = out.replace(/<\/?Columns>/g, "");
  out = out.replace(/<\/?CardGroup[^>]*>/g, "");

  // ── <Steps>/<Step title="..."> → numbered headings ──
  out = out.replace(/<\/?Steps>/g, "");
  let localStepCounter = 0;
  out = out.replace(/<Step\s+title="([^"]*)"[^>]*>/g, (_match, title) => {
    localStepCounter++;
    return `#### Step ${localStepCounter}: ${title}`;
  });
  out = out.replace(/<\/Step>/g, "");

  // ── <Tabs>/<Tab title="..."> → bold section headers ──
  out = out.replace(/<\/?Tabs>/g, "");
  out = out.replace(/<Tab\s+title="([^"]*)"[^>]*>/g, (_match, title) => `**${title}:**\n`);
  out = out.replace(/<\/Tab>/g, "");

  // ── <Accordion title="...">content</Accordion> → details-like block ──
  out = out.replace(
    /<Accordion\s+title="([^"]*)"[^>]*>/g,
    (_match, title) => `<details>\n<summary>${title}</summary>\n`,
  );
  out = out.replace(/<\/Accordion>/g, "\n</details>\n");
  out = out.replace(/<\/?AccordionGroup>/g, "");

  // ── Callout blocks: <Tip>, <Note>, <Warning>, <Info>, <Check> → blockquotes ──
  const calloutTypes: Record<string, string> = {
    Tip: "💡 **Tip:**",
    Note: "📝 **Note:**",
    Warning: "⚠️ **Warning:**",
    Info: "ℹ️ **Info:**",
    Check: "✅ **Check:**",
    Error: "❌ **Error:**",
  };
  for (const [tag, prefix] of Object.entries(calloutTypes)) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
    out = out.replace(re, (_match, body: string) => {
      const lines = body.trim().split("\n");
      return lines.map((line, i) => (i === 0 ? `> ${prefix} ${line}` : `> ${line}`)).join("\n");
    });
  }

  // ── <Frame>/<Frame ...> → strip (just wraps images) ──
  out = out.replace(/<\/?Frame[^>]*>/g, "");

  // ── <Tooltip ...>text</Tooltip> → just the text ──
  out = out.replace(/<Tooltip[^>]*>([\s\S]*?)<\/Tooltip>/g, "$1");

  // ── <img src="..." alt="..." ... /> → markdown image ──
  out = out.replace(/<img\s+[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*\/?>/g, "![$2]($1)");
  out = out.replace(/<img\s+[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*\/?>/g, "![$1]($2)");

  // ── Remaining simple HTML: <strong>, <br>, <code> ──
  out = out.replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**");
  out = out.replace(/<br\s*\/?>/g, "\n");
  out = out.replace(/<code>([\s\S]*?)<\/code>/g, "`$1`");

  // ── Rewrite internal doc links: ](/start/foo) → ](/openclaw-docs/start/foo) ──
  // Mintlify docs use root-relative paths like (/start/getting-started).
  // In ui-next, these live under /openclaw-docs/*. Without rewriting,
  // clicking a link navigates to a non-existent route.
  // Match markdown links: ](/ but NOT ](http or ](// or ](/openclaw-docs/ (already rewritten)
  out = out.replace(/\]\(\/(?!openclaw-docs\/)(?!\/|http)([^)]+)\)/g, "](/openclaw-docs/$1)");

  // Also rewrite href= attributes in any remaining HTML-style links
  out = out.replace(/href="\/(?!openclaw-docs\/)(?!\/|http)([^"]+)"/g, 'href="/openclaw-docs/$1"');

  // ── Clean up excessive blank lines ──
  out = out.replace(/\n{4,}/g, "\n\n\n");

  return out;
}

function toTitleCase(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Parse file paths → folder/slug ───────────────────────────────────────────

interface ParsedFile {
  folder: string; // "channels" | "_root"
  slug: string; // "telegram"
  rawContent: string;
}

const parsedFiles: ParsedFile[] = [];

for (const [importPath, raw] of Object.entries(rawDocs)) {
  // importPath e.g. "../../../docs/channels/telegram.md"
  const docsMatch = importPath.match(/\/docs\/(.+)$/);
  if (!docsMatch) {
    continue;
  }

  const relPath = docsMatch[1]; // "channels/telegram.md"
  const parts = relPath.split("/");

  // Skip deeply nested (> 2 levels) for now
  if (parts.length > 2) {
    continue;
  }

  let folder: string;
  let slug: string;

  if (parts.length === 1) {
    folder = "_root";
    slug = parts[0].replace(/\.md$/, "");
  } else {
    folder = parts[0];
    slug = parts[1].replace(/\.md$/, "");
  }

  parsedFiles.push({ folder, slug, rawContent: raw });
}

// ── Group by folder and sort ──────────────────────────────────────────────────

const byFolder = new Map<string, ParsedFile[]>();
for (const f of parsedFiles) {
  if (!byFolder.has(f.folder)) {
    byFolder.set(f.folder, []);
  }
  byFolder.get(f.folder)!.push(f);
}

const sortedFolders = [...byFolder.keys()].toSorted((a, b) => {
  const oa = FOLDER_ORDER[a] ?? 999;
  const ob = FOLDER_ORDER[b] ?? 999;
  if (oa !== ob) {
    return oa - ob;
  }
  return a.localeCompare(b);
});

for (const files of byFolder.values()) {
  files.sort((a, b) => {
    if (a.slug === "index") {
      return -1;
    }
    if (b.slug === "index") {
      return 1;
    }
    return a.slug.localeCompare(b.slug);
  });
}

// ── Build fumadocs virtual files ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const files: any[] = [];

// Root meta — top-level folder list (exclude _root as a section)
const sectionIds = sortedFolders.filter((f) => f !== "_root");
files.push({
  type: "meta",
  path: "meta.json",
  data: { title: "OpenClaw Docs", pages: sectionIds } satisfies MetaData,
});

// Root-level pages (e.g. docs/index.md, docs/pi.md)
for (const f of byFolder.get("_root") ?? []) {
  const title = extractTitle(f.rawContent, toTitleCase(f.slug));
  files.push({
    type: "page",
    path: `${f.slug}.md`,
    data: {
      title,
      description: extractDescription(f.rawContent),
      content: sanitizeMintlifyContent(stripFrontmatter(f.rawContent)),
      updated: extractUpdated(f.rawContent),
    } satisfies DocsPageData,
  });
}

// Folder sections
for (const folder of sectionIds) {
  const folderFiles = byFolder.get(folder) ?? [];
  const label = FOLDER_LABEL[folder] ?? toTitleCase(folder);

  files.push({
    type: "meta",
    path: `${folder}/meta.json`,
    data: {
      title: label,
      pages: folderFiles.map((f) => (f.slug === folder ? "index" : f.slug)),
    } satisfies MetaData,
  });

  for (const f of folderFiles) {
    const title = extractTitle(f.rawContent, toTitleCase(f.slug));
    const virtualName = f.slug === folder ? "index" : f.slug;
    files.push({
      type: "page",
      path: `${folder}/${virtualName}.md`,
      data: {
        title,
        description: extractDescription(f.rawContent),
        content: sanitizeMintlifyContent(stripFrontmatter(f.rawContent)),
        updated: extractUpdated(f.rawContent),
      } satisfies DocsPageData,
    });
  }
}

// ── Source loader ─────────────────────────────────────────────────────────────

export const openclawDocsSource = loader({
  baseUrl: "/openclaw-docs",
  source: { files },
});

export function getAllOpenClawPages() {
  return openclawDocsSource.getPages();
}

export function getOpenClawDocPage(slugs?: string[]) {
  return openclawDocsSource.getPage(slugs);
}

export const openclawDocsPageTree = openclawDocsSource.pageTree;
