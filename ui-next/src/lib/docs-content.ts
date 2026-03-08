// Build-time import of all operator1 docs as raw markdown strings
const rawDocs = import.meta.glob("../../../docs/operator1/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

export type DocPage = {
  slug: string;
  title: string;
  content: string;
  category: string;
};

export type DocCategory = {
  id: string;
  label: string;
  pages: string[];
};

export const docsCategories: DocCategory[] = [
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
    pages: ["rpc", "deployment", "channels", "spawning"],
  },
];

/** Extract title from frontmatter `title:` or first `# heading` */
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

/** Strip frontmatter block from markdown content */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
}

/** Build slug-to-category lookup */
const slugToCategory = new Map<string, string>();
for (const cat of docsCategories) {
  for (const page of cat.pages) {
    slugToCategory.set(page, cat.id);
  }
}

/** All docs indexed by slug */
export const docsPages: Record<string, DocPage> = {};

for (const [path, raw] of Object.entries(rawDocs)) {
  // path looks like "../../../docs/operator1/architecture.md"
  const filename = path.split("/").pop()?.replace(/\.md$/, "");
  if (!filename) {
    continue;
  }

  docsPages[filename] = {
    slug: filename,
    title: extractTitle(raw as string),
    content: stripFrontmatter(raw as string),
    category: slugToCategory.get(filename) ?? "overview",
  };
}

/** Get ordered list of pages for a category */
export function getCategoryPages(categoryId: string): DocPage[] {
  const cat = docsCategories.find((c) => c.id === categoryId);
  if (!cat) {
    return [];
  }
  return cat.pages.map((slug) => docsPages[slug]).filter(Boolean);
}
