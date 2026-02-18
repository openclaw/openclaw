/**
 * Houdini Claw - Documentation Crawler
 *
 * Crawls SideFX official documentation and community sources to build
 * the raw material for the annotation pipeline.
 *
 * Usage:
 *   bun src/houdini-claw/crawl.ts --mode full|incremental --output /tmp/houdini-raw/
 *   bun src/houdini-claw/crawl.ts --mode full --discover --output /tmp/houdini-raw/
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseHTML } from "linkedom";

// ── Types ──────────────────────────────────────────────────

export interface CrawlSource {
  id: string;
  type: "sidefx_docs" | "sidefx_forum" | "odforce" | "tutorial" | "hip_file";
  baseUrl: string;
  priority: number; // 0 = highest
  enabled: boolean;
}

/** A parameter extracted from a SideFX documentation page. */
export interface DocParameter {
  name: string;
  label: string;
  description: string;
  folder: string;
}

/** Structured result from parsing a SideFX node documentation page. */
export interface ParsedNodeDoc {
  title: string;
  summary: string;
  parameters: DocParameter[];
  sections: Array<{ heading: string; content: string }>;
  relatedNodes: string[];
  rawText: string;
}

export interface CrawledPage {
  url: string;
  sourceType: string;
  nodeName?: string;
  title: string;
  content: string;
  contentHash: string;
  crawledAt: string;
  /** Structured parameter data extracted via DOM parsing (sidefx_docs only). */
  parsedDoc?: ParsedNodeDoc;
}

/** A node discovered from the SideFX docs sitemap. */
export interface DiscoveredNode {
  path: string;
  category: string;
  nodeType: string;
  lastmod?: string;
}

// ── Source Configuration ───────────────────────────────────

const CRAWL_SOURCES: CrawlSource[] = [
  {
    id: "sidefx-docs",
    type: "sidefx_docs",
    baseUrl: "https://www.sidefx.com/docs/houdini/",
    priority: 0,
    enabled: true,
  },
  {
    id: "sidefx-forum",
    type: "sidefx_forum",
    baseUrl: "https://www.sidefx.com/forum/",
    priority: 1,
    enabled: true,
  },
  {
    id: "odforce",
    type: "odforce",
    baseUrl: "https://forums.odforce.net/",
    priority: 1,
    enabled: true,
  },
];

// ── Known Houdini Node Paths ───────────────────────────────
// Priority whitelist: these nodes are always crawled first.

const PYRO_NODES = [
  "nodes/dop/pyrosolver",
  "nodes/dop/smokesolver",
  "nodes/dop/smokeobject",
  "nodes/dop/gasresizedynamic",
  "nodes/dop/gasdissipate",
  "nodes/dop/gasbuoyancy",
  "nodes/dop/gasturbulence",
  "nodes/dop/sourcevolume",
  "nodes/dop/gasvorticleforces",
  "nodes/dop/gasenforceboundary",
  "nodes/dop/gasmatchfield",
  "nodes/dop/gasresize",
  "nodes/dop/gasadvect",
  "nodes/dop/gasproject",
  "nodes/dop/gascalculate",
  "nodes/sop/pyrosource",
  "nodes/sop/volumesource",
  "nodes/sop/volume",
  "nodes/sop/volumevop",
  "nodes/sop/volumerasterizeattributes",
];

const RBD_NODES = [
  "nodes/dop/bulletrbdsolver",
  "nodes/dop/rbdpackedobject",
  "nodes/dop/constraintnetwork",
  "nodes/dop/conetwistconrel",
  "nodes/dop/glueconrel",
  "nodes/dop/springconrel",
  "nodes/dop/hardconrel",
  "nodes/sop/voronoifracture",
  "nodes/sop/booleanfracture",
  "nodes/sop/rbdmaterialfracture",
  "nodes/sop/assemble",
  "nodes/sop/connectadjacentpieces",
  "nodes/sop/rbdinteriordetail",
  "nodes/sop/rbdconstraints",
];

const FLIP_NODES = [
  "nodes/dop/flipsolver",
  "nodes/dop/flipobject",
  "nodes/dop/whitewatersolvercompact",
  "nodes/dop/particlefluidobject",
  "nodes/dop/gassandforces",
  "nodes/sop/particlefluidsurface",
  "nodes/sop/oceansource",
  "nodes/sop/oceanspectrum",
  "nodes/sop/oceanevaluate",
  "nodes/sop/flattenedtank",
  "nodes/sop/narrowbandflip",
];

const VELLUM_NODES = [
  "nodes/dop/vellumsolver",
  "nodes/dop/vellumobject",
  "nodes/sop/vellumconstraints",
  "nodes/sop/vellumdrape",
  "nodes/sop/vellumpostprocess",
  "nodes/sop/vellumrestblend",
  "nodes/sop/vellumsolver-sop",
  "nodes/sop/vellumpack",
];

const CORE_SOP_NODES = [
  "nodes/sop/scatter",
  "nodes/sop/attribute_wrangle",
  "nodes/sop/pointwrangle",
  "nodes/sop/for_each",
  "nodes/sop/copytopoints",
  "nodes/sop/transform",
  "nodes/sop/merge",
  "nodes/sop/blast",
  "nodes/sop/group",
  "nodes/sop/fuse",
  "nodes/sop/clean",
  "nodes/sop/normal",
  "nodes/sop/subdivide",
  "nodes/sop/remesh",
  "nodes/sop/boolean",
  "nodes/sop/polyextrude",
  "nodes/sop/measure",
  "nodes/sop/uvunwrap",
];

export const ALL_NODE_PATHS: Record<string, string[]> = {
  pyro: PYRO_NODES,
  rbd: RBD_NODES,
  flip: FLIP_NODES,
  vellum: VELLUM_NODES,
  sop: CORE_SOP_NODES,
};

// ── Structured HTML Parsing ──────────────────────────────────

const FETCH_HEADERS = {
  "User-Agent": "HoudiniClaw/1.0 (knowledge-base-builder)",
  Accept: "text/html",
};

/**
 * Parse a SideFX documentation HTML page into structured data
 * using linkedom for proper DOM traversal.
 *
 * SideFX docs use: <h2> for section headings (tabs/folders),
 * <h3> for parameter labels, <p> for descriptions.
 */
export function parseSideFxNodeDoc(html: string): ParsedNodeDoc {
  const { document } = parseHTML(html);

  // Remove noise
  for (const tag of ["script", "style", "nav", "footer", "header"]) {
    for (const el of document.querySelectorAll(tag)) {
      el.remove();
    }
  }

  const title = document.querySelector("h1")?.textContent?.trim() ?? "";
  const summaryEl =
    document.querySelector(".summary") ??
    document.querySelector("#content > .content > p");
  const summary = summaryEl?.textContent?.trim() ?? "";

  // ── Extract parameters ──
  const parameters: DocParameter[] = [];
  const parmContainer =
    document.querySelector("#parmpane") ??
    document.querySelector(".parmpane") ??
    document.querySelector(".parms") ??
    document.querySelector("#content .content");

  if (parmContainer) {
    let currentFolder = "General";
    let lastParam: DocParameter | null = null;

    const walk = (node: ChildNode) => {
      if (node.nodeType !== 1) return; // ELEMENT_NODE only
      const el = node as unknown as Element;
      const tag = el.tagName?.toUpperCase();

      if (tag === "H2") {
        currentFolder = el.textContent?.trim() ?? currentFolder;
        lastParam = null;
      } else if (tag === "H3") {
        const label = el.textContent?.trim() ?? "";
        if (label) {
          lastParam = {
            name: el.id || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            label,
            description: "",
            folder: currentFolder,
          };
          parameters.push(lastParam);
        }
      } else if (tag === "P" && lastParam && !lastParam.description) {
        const text = el.textContent?.trim() ?? "";
        if (text) lastParam.description = text;
      }

      // Recurse into children
      for (const child of el.childNodes) {
        walk(child);
      }
    };

    for (const child of parmContainer.childNodes) {
      walk(child);
    }
  }

  // ── Extract sections ──
  const sections: Array<{ heading: string; content: string }> = [];
  const allH2 = document.querySelectorAll("h2");
  for (const h2 of allH2) {
    const heading = h2.textContent?.trim() ?? "";
    if (!heading) continue;

    const parts: string[] = [];
    let sibling = h2.nextElementSibling;
    while (sibling && sibling.tagName?.toUpperCase() !== "H2") {
      const text = sibling.textContent?.trim();
      if (text) parts.push(text);
      sibling = sibling.nextElementSibling;
    }
    if (parts.length > 0) {
      sections.push({ heading, content: parts.join("\n") });
    }
  }

  // ── Related nodes ──
  const relatedSet = new Set<string>();
  for (const link of document.querySelectorAll('a[href*="/nodes/"]')) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const m = href.match(/\/nodes\/(\w+)\/([\w-]+)/);
    if (m) relatedSet.add(`nodes/${m[1]}/${m[2]}`);
  }

  // ── Raw text fallback ──
  const contentEl = document.querySelector("#content") ?? document.body;
  const rawText = (contentEl?.textContent ?? "").replace(/\s+/g, " ").trim();

  return {
    title,
    summary,
    parameters,
    sections,
    relatedNodes: [...relatedSet],
    rawText,
  };
}

// ── Sitemap Discovery ────────────────────────────────────────

/**
 * Discover all node documentation pages from the SideFX docs sitemap.
 */
export async function discoverNodesFromSitemap(
  baseUrl: string = "https://www.sidefx.com/docs/houdini/",
): Promise<DiscoveredNode[]> {
  const sitemapUrl = `${baseUrl}sitemap.xml`;

  try {
    const resp = await fetch(sitemapUrl, { headers: FETCH_HEADERS });
    if (!resp.ok) {
      console.warn(`[crawl] Sitemap fetch failed: HTTP ${resp.status}`);
      return [];
    }

    const xml = await resp.text();
    const nodes: DiscoveredNode[] = [];

    const urlBlockPattern = /<url>([\s\S]*?)<\/url>/g;
    let block: RegExpExecArray | null;

    while ((block = urlBlockPattern.exec(xml)) !== null) {
      const entry = block[1];
      const loc = entry.match(/<loc>(.*?)<\/loc>/)?.[1] ?? "";
      const lastmod = entry.match(/<lastmod>(.*?)<\/lastmod>/)?.[1];

      const nodeMatch = loc.match(/\/nodes\/(\w+)\/([\w-]+?)(?:\.html)?$/);
      if (nodeMatch) {
        nodes.push({
          path: `nodes/${nodeMatch[1]}/${nodeMatch[2]}`,
          category: nodeMatch[1].toUpperCase(),
          nodeType: nodeMatch[2],
          lastmod: lastmod ?? undefined,
        });
      }
    }

    console.log(`[crawl] Sitemap: discovered ${nodes.length} node pages`);
    return nodes;
  } catch (err) {
    console.error("[crawl] Sitemap discovery failed:", (err as Error).message);
    return [];
  }
}

/**
 * Categorize a node path into a simulation system.
 */
function categorizeNodePath(nodePath: string): string {
  const lower = nodePath.toLowerCase();

  if (/pyro|smoke|fire|combustion|gas(?!sand)/.test(lower)) return "pyro";
  if (/flip|ocean|whitewater|particlefluid|narrowband/.test(lower)) return "flip";
  if (/rbd|bullet|voronoi|fracture|constraint|glue|spring|cone.*twist/.test(lower)) return "rbd";
  if (/vellum/.test(lower)) return "vellum";

  const category = nodePath.match(/^nodes\/(\w+)\//)?.[1];
  return category ?? "other";
}

/**
 * Resolve node paths by merging the priority whitelist with sitemap discovery.
 *
 * - "whitelist": only hardcoded ALL_NODE_PATHS
 * - "discover": only sitemap results
 * - "both": whitelist nodes first, then discovered nodes not in the whitelist
 */
export async function resolveNodePaths(
  mode: "whitelist" | "discover" | "both" = "whitelist",
  baseUrl?: string,
): Promise<Record<string, string[]>> {
  if (mode === "whitelist") {
    return ALL_NODE_PATHS;
  }

  const discovered = await discoverNodesFromSitemap(baseUrl);
  const discoveredMap: Record<string, string[]> = {};

  for (const node of discovered) {
    const system = categorizeNodePath(node.path);
    if (!discoveredMap[system]) discoveredMap[system] = [];
    discoveredMap[system].push(node.path);
  }

  if (mode === "discover") {
    return discoveredMap;
  }

  // mode === "both": merge whitelist + discovered
  const whitelistSet = new Set(Object.values(ALL_NODE_PATHS).flat());
  const merged: Record<string, string[]> = {};

  for (const [system, paths] of Object.entries(ALL_NODE_PATHS)) {
    merged[system] = [...paths];
  }
  for (const [system, paths] of Object.entries(discoveredMap)) {
    if (!merged[system]) merged[system] = [];
    for (const p of paths) {
      if (!whitelistSet.has(p)) {
        merged[system].push(p);
      }
    }
  }

  return merged;
}

// ── Crawler Functions ──────────────────────────────────────

/**
 * Crawl a single SideFX documentation page and extract structured content.
 */
export async function crawlSideFxDoc(
  nodePath: string,
  baseUrl: string = "https://www.sidefx.com/docs/houdini/",
): Promise<CrawledPage | null> {
  const url = `${baseUrl}${nodePath}.html`;
  const nodeName = nodePath.split("/").pop() ?? nodePath;

  try {
    const response = await fetch(url, { headers: FETCH_HEADERS });

    if (!response.ok) {
      console.warn(`[crawl] HTTP ${response.status} for ${url}`);
      return null;
    }

    const html = await response.text();
    const parsedDoc = parseSideFxNodeDoc(html);

    // Build structured content string for hashing and backward compat
    const contentParts = [parsedDoc.title, parsedDoc.summary];

    if (parsedDoc.parameters.length > 0) {
      contentParts.push("## Parameters");
      for (const p of parsedDoc.parameters) {
        contentParts.push(`### ${p.label} (${p.folder})`);
        if (p.description) contentParts.push(p.description);
      }
    }

    for (const s of parsedDoc.sections) {
      contentParts.push(`## ${s.heading}`);
      contentParts.push(s.content);
    }

    const content = contentParts.filter(Boolean).join("\n\n");
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");

    return {
      url,
      sourceType: "sidefx_docs",
      nodeName,
      title: parsedDoc.title || nodeName,
      content,
      contentHash,
      crawledAt: new Date().toISOString(),
      parsedDoc,
    };
  } catch (err) {
    console.error(`[crawl] Failed to fetch ${url}:`, (err as Error).message);
    return null;
  }
}

/**
 * Run a full or incremental crawl of all configured sources.
 */
export async function runCrawl(options: {
  mode: "full" | "incremental";
  outputDir: string;
  systems?: string[];
  /** How to resolve node paths: whitelist, discover (sitemap), or both. */
  nodeDiscovery?: "whitelist" | "discover" | "both";
  onProgress?: (fetched: number, total: number, nodeName: string) => void;
}): Promise<CrawledPage[]> {
  const { mode, outputDir, systems, nodeDiscovery = "whitelist" } = options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const resolvedPaths = await resolveNodePaths(nodeDiscovery);
  const targetSystems = systems ?? Object.keys(resolvedPaths);
  const allPaths: Array<{ system: string; path: string }> = [];

  for (const system of targetSystems) {
    const paths = resolvedPaths[system];
    if (paths) {
      for (const p of paths) {
        allPaths.push({ system, path: p });
      }
    }
  }

  const results: CrawledPage[] = [];
  const total = allPaths.length;
  let fetched = 0;

  for (const { system, path: nodePath } of allPaths) {
    const nodeName = nodePath.split("/").pop() ?? nodePath;

    if (mode === "incremental") {
      const outputFile = path.join(outputDir, `${system}--${nodeName}.json`);
      if (fs.existsSync(outputFile)) {
        fetched++;
        options.onProgress?.(fetched, total, nodeName);
        continue;
      }
    }

    const page = await crawlSideFxDoc(nodePath);
    if (page) {
      const outputFile = path.join(outputDir, `${system}--${nodeName}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(page, null, 2));
      results.push(page);
    }

    fetched++;
    options.onProgress?.(fetched, total, nodeName);

    // Rate limit
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return results;
}

// ── CLI Entry Point ────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf("--mode");
  const outputIdx = args.indexOf("--output");
  const systemIdx = args.indexOf("--system");
  const hasDiscover = args.includes("--discover");
  const discoverOnly = args.includes("--discover-only");

  const mode = (modeIdx !== -1 ? args[modeIdx + 1] : "full") as "full" | "incremental";
  const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : "/tmp/houdini-raw";
  const systems = systemIdx !== -1 ? args[systemIdx + 1].split(",") : undefined;

  let nodeDiscovery: "whitelist" | "discover" | "both" = "whitelist";
  if (discoverOnly) nodeDiscovery = "discover";
  else if (hasDiscover) nodeDiscovery = "both";

  console.log(`[crawl] Starting ${mode} crawl -> ${outputDir} (discovery: ${nodeDiscovery})`);
  if (systems) {
    console.log(`[crawl] Systems: ${systems.join(", ")}`);
  }

  runCrawl({
    mode,
    outputDir,
    systems,
    nodeDiscovery,
    onProgress: (fetched, total, nodeName) => {
      console.log(`[crawl] ${fetched}/${total}: ${nodeName}`);
    },
  }).then((results) => {
    console.log(`[crawl] Done. ${results.length} pages crawled.`);
  });
}
