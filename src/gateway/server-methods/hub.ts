/**
 * Operator1Hub RPC handlers.
 *
 * Provides a built-in, curated registry of skills, agents, and commands
 * fetched from github.com/Interstellar-code/operator1hub (static manifest).
 *
 * Supports both https:// (production) and file:// (local dev/testing) URLs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { join } from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  deleteHubInstalledFromDb,
  getAllHubInstalledFromDb,
  getHubCatalogItemFromDb,
  getHubCatalogItemsFromDb,
  getHubCollectionsFromDb,
  getHubInstalledItemFromDb,
  getHubSyncMeta,
  insertHubInstalledInDb,
  replaceHubCatalogInDb,
  replaceHubCollectionsInDb,
  setHubSyncMeta,
  type HubCatalogItem,
  type HubItemType,
} from "../../infra/state-db/hub-sqlite.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_HUB_URL =
  "https://raw.githubusercontent.com/Interstellar-code/operator1hub/main/registry.json";

const STALE_MS = 24 * 60 * 60 * 1000; // 24h

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveHubUrl(): string {
  const cfg = loadConfig();
  return cfg.hub?.url?.trim() || DEFAULT_HUB_URL;
}

function isCatalogStale(syncedAt: string | undefined): boolean {
  if (!syncedAt) {
    return true;
  }
  return Date.now() - new Date(syncedAt).getTime() > STALE_MS;
}

/**
 * Derive the base URL for fetching hub content items.
 * Strips the registry filename and returns the directory URL.
 */
function resolveHubBaseUrl(manifestUrl: string): string {
  if (manifestUrl.startsWith("file://")) {
    const filePath = new URL(manifestUrl).pathname;
    return "file://" + path.dirname(filePath);
  }
  // For https://, strip the filename
  const lastSlash = manifestUrl.lastIndexOf("/");
  return lastSlash >= 0 ? manifestUrl.slice(0, lastSlash) : manifestUrl;
}

/** Build full URL for a content item path (resolves relative to manifest base). */
function resolveContentUrl(baseUrl: string, itemPath: string): string {
  if (baseUrl.startsWith("file://")) {
    return "file://" + path.join(new URL(baseUrl).pathname, itemPath);
  }
  return `${baseUrl}/${itemPath}`;
}

/** Fetch a URL — supports https:// and file://. Returns text content. */
async function fetchUrl(url: string): Promise<string> {
  if (url.startsWith("file://")) {
    return readFile(new URL(url).pathname, "utf-8");
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "operator1-gateway/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  }
  return res.text();
}

/** Verify SHA-256 of content matches expected hash. */
function verifySha256(content: string, expected: string): boolean {
  const actual = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return actual === expected;
}

/** Workspace resolver (mirrors clawhub.ts pattern). */
type WorkspaceResolved = { workspaceDir: string; agentId: string };
type WorkspaceError = { error: string };

function resolveWorkspace(params: Record<string, unknown>): WorkspaceResolved | WorkspaceError {
  const cfg = loadConfig();
  const agentIdRaw = typeof params.agentId === "string" ? params.agentId.trim() : "";
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
  if (agentIdRaw) {
    const known = listAgentIds(cfg);
    if (!known.includes(agentId)) {
      return { error: `unknown agent id "${agentIdRaw}"` };
    }
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return { workspaceDir, agentId };
}

/** Load bundled persona slugs from the local agents/personas/_index.json. */
async function loadBundledPersonaSlugs(): Promise<Set<string>> {
  try {
    // Resolve relative to this file's directory: gateway/server-methods/ → agents/personas/
    const indexPath = join(import.meta.dirname, "..", "..", "agents", "personas", "_index.json");
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as { personas?: Array<{ slug: string }> };
    const slugs = new Set<string>();
    for (const p of index.personas ?? []) {
      if (typeof p.slug === "string") {
        slugs.add(p.slug);
      }
    }
    return slugs;
  } catch {
    // Non-fatal — bundled detection is best-effort
    return new Set();
  }
}

/** Parse and validate the registry.json manifest. */
interface RegistryManifest {
  version: number;
  items: Array<Record<string, unknown>>;
  collections: Array<Record<string, unknown>>;
}

function parseManifest(raw: string): RegistryManifest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.version !== "number") {
    throw new Error("Invalid registry.json: missing version field");
  }
  return {
    version: parsed.version,
    items: Array.isArray(parsed.items) ? (parsed.items as Array<Record<string, unknown>>) : [],
    collections: Array.isArray(parsed.collections)
      ? (parsed.collections as Array<Record<string, unknown>>)
      : [],
  };
}

function manifestItemToCatalogItem(raw: Record<string, unknown>): HubCatalogItem | null {
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const type = raw.type as string;
  const category = typeof raw.category === "string" ? raw.category : "general";
  const path_ = typeof raw.path === "string" ? raw.path : "";
  const version = typeof raw.version === "string" ? raw.version : "1.0.0";

  if (!slug || !name || !["skill", "agent", "command"].includes(type) || !path_) {
    return null;
  }

  return {
    slug,
    name,
    type: type as HubItemType,
    category,
    description: typeof raw.description === "string" ? raw.description : null,
    path: path_,
    readme: typeof raw.readme === "string" ? raw.readme : null,
    version,
    tags: Array.isArray(raw.tags)
      ? (raw.tags as string[]).filter((t) => typeof t === "string")
      : [],
    emoji: typeof raw.emoji === "string" ? raw.emoji : null,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : null,
    bundled: false, // set later by bundled detection
  };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export const hubHandlers: GatewayRequestHandlers = {
  // ── hub.sync ──────────────────────────────────────────────────────────────
  "hub.sync": async ({ respond }) => {
    const hubUrl = resolveHubUrl();

    let rawManifest: string;
    try {
      rawManifest = await fetchUrl(hubUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to fetch hub registry from ${hubUrl}: ${msg}`),
      );
      return;
    }

    let manifest: RegistryManifest;
    try {
      manifest = parseManifest(rawManifest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to parse hub registry.json: ${msg}`),
      );
      return;
    }

    // Convert manifest items to catalog items
    const items: HubCatalogItem[] = [];
    for (const raw of manifest.items) {
      const item = manifestItemToCatalogItem(raw);
      if (item) {
        items.push(item);
      }
    }

    // Detect bundled personas — mark agent items that exist in local personas index
    const bundledSlugs = await loadBundledPersonaSlugs();
    for (const item of items) {
      if (item.type === "agent" && bundledSlugs.has(item.slug)) {
        item.bundled = true;
      }
    }

    // Parse collections
    const collections = manifest.collections
      .map((raw) => {
        const slug = typeof raw.slug === "string" ? raw.slug : "";
        const name = typeof raw.name === "string" ? raw.name : "";
        if (!slug || !name) {
          return null;
        }
        return {
          slug,
          name,
          description: typeof raw.description === "string" ? raw.description : null,
          emoji: typeof raw.emoji === "string" ? raw.emoji : null,
          items: Array.isArray(raw.items)
            ? (raw.items as string[]).filter((s) => typeof s === "string")
            : [],
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const syncedAt = new Date().toISOString();
    replaceHubCatalogInDb(items);
    replaceHubCollectionsInDb(collections);
    setHubSyncMeta({ syncedAt, totalItems: items.length });

    respond(
      true,
      {
        syncedAt,
        totalItems: items.length,
        bundledAgents: items.filter((i) => i.bundled).length,
        collections: collections.length,
      },
      undefined,
    );
  },

  // ── hub.catalog ───────────────────────────────────────────────────────────
  "hub.catalog": ({ params, respond }) => {
    const p = params;
    const syncMeta = getHubSyncMeta();

    if (!syncMeta) {
      respond(true, { syncedAt: null, stale: true, total: 0, filtered: 0, items: [] }, undefined);
      return;
    }

    const stale = isCatalogStale(syncMeta.syncedAt);

    const typeFilter =
      typeof p.type === "string" && ["skill", "agent", "command"].includes(p.type)
        ? (p.type as HubItemType)
        : undefined;
    const categoryFilter =
      typeof p.category === "string" && p.category !== "all" ? p.category : undefined;

    let items = getHubCatalogItemsFromDb({ type: typeFilter, category: categoryFilter });

    // Text search across name, description, tags
    const search = typeof p.search === "string" ? p.search.toLowerCase().trim() : "";
    if (search) {
      items = items.filter((item) => {
        return (
          item.name.toLowerCase().includes(search) ||
          (item.description?.toLowerCase().includes(search) ?? false) ||
          item.slug.toLowerCase().includes(search) ||
          item.tags.some((t) => t.toLowerCase().includes(search))
        );
      });
    }

    const all = getHubCatalogItemsFromDb();

    respond(
      true,
      {
        syncedAt: syncMeta.syncedAt,
        stale,
        total: all.length,
        filtered: items.length,
        items,
      },
      undefined,
    );
  },

  // ── hub.search ────────────────────────────────────────────────────────────
  "hub.search": ({ params, respond }) => {
    const query = typeof params.query === "string" ? params.query.toLowerCase().trim() : "";
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query is required"));
      return;
    }

    const all = getHubCatalogItemsFromDb();
    const results = all.filter((item) => {
      return (
        item.name.toLowerCase().includes(query) ||
        (item.description?.toLowerCase().includes(query) ?? false) ||
        item.slug.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query) ||
        item.tags.some((t) => t.toLowerCase().includes(query))
      );
    });

    respond(true, { query, total: results.length, items: results }, undefined);
  },

  // ── hub.inspect ───────────────────────────────────────────────────────────
  "hub.inspect": async ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }

    const item = getHubCatalogItemFromDb(slug);
    if (!item) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `hub item "${slug}" not found in catalog`),
      );
      return;
    }

    const hubUrl = resolveHubUrl();
    const baseUrl = resolveHubBaseUrl(hubUrl);

    // Prefer readme path, fall back to the item's main path
    const contentPath = item.readme ?? item.path;
    const contentUrl = resolveContentUrl(baseUrl, contentPath);

    let content = "";
    try {
      content = await fetchUrl(contentUrl);
    } catch {
      // Non-fatal: return metadata without content
    }

    respond(
      true,
      {
        slug: item.slug,
        name: item.name,
        type: item.type,
        version: item.version,
        description: item.description,
        emoji: item.emoji,
        tags: item.tags,
        category: item.category,
        bundled: item.bundled,
        content,
        fetchedAt: new Date().toISOString(),
      },
      undefined,
    );
  },

  // ── hub.install ───────────────────────────────────────────────────────────
  "hub.install": async ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }

    const item = getHubCatalogItemFromDb(slug);
    if (!item) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `hub item "${slug}" not found in catalog`),
      );
      return;
    }

    // Bundled agents already exist locally — no-op
    if (item.bundled) {
      respond(
        true,
        {
          ok: true,
          slug,
          bundled: true,
          message: `"${item.name}" is bundled with operator1 and already available`,
        },
        undefined,
      );
      return;
    }

    // Resolve workspace for per-agent items
    const resolved = resolveWorkspace(params);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const { workspaceDir, agentId } = resolved;

    // Determine install path based on item type
    let installDir: string;
    let installPath: string;

    if (item.type === "skill") {
      installDir = path.join(workspaceDir, "skills", slug);
      installPath = path.join(installDir, "SKILL.md");
    } else if (item.type === "agent") {
      installDir = path.join(workspaceDir, "agents");
      installPath = path.join(installDir, `${slug}.md`);
    } else {
      // command — global, not per-agent
      const stateDir = resolveStateDir(process.env);
      installDir = path.join(stateDir, "commands");
      installPath = path.join(installDir, `${slug}.md`);
    }

    // Fetch content
    const hubUrl = resolveHubUrl();
    const baseUrl = resolveHubBaseUrl(hubUrl);
    const contentUrl = resolveContentUrl(baseUrl, item.path);

    let content: string;
    try {
      content = await fetchUrl(contentUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to fetch hub item "${slug}": ${msg}`),
      );
      return;
    }

    // Verify SHA-256 integrity
    if (item.sha256 && !verifySha256(content, item.sha256)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Integrity check failed for "${slug}": SHA-256 mismatch`,
        ),
      );
      return;
    }

    // Write to disk
    try {
      fs.mkdirSync(installDir, { recursive: true });
      fs.writeFileSync(installPath, content, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to write hub item "${slug}": ${msg}`),
      );
      return;
    }

    // Track in DB
    insertHubInstalledInDb({
      slug,
      type: item.type,
      version: item.version,
      installPath,
      agentId: item.type === "command" ? null : agentId,
    });

    respond(
      true,
      {
        ok: true,
        slug,
        type: item.type,
        version: item.version,
        installPath,
        requiresRestart: item.type === "skill",
      },
      undefined,
    );
  },

  // ── hub.remove ────────────────────────────────────────────────────────────
  "hub.remove": ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }

    const installed = getHubInstalledItemFromDb(slug);
    if (!installed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `hub item "${slug}" is not installed`),
      );
      return;
    }

    // Delete files
    if (fs.existsSync(installed.installPath)) {
      if (installed.type === "skill") {
        // Skills are installed as a directory
        const skillDir = path.dirname(installed.installPath);
        fs.rmSync(skillDir, { recursive: true, force: true });
      } else {
        fs.rmSync(installed.installPath, { force: true });
      }
    }

    deleteHubInstalledFromDb(slug);
    respond(true, { ok: true, slug }, undefined);
  },

  // ── hub.installed ─────────────────────────────────────────────────────────
  "hub.installed": ({ respond }) => {
    const installed = getAllHubInstalledFromDb();

    // Enrich with catalog metadata
    const enriched = installed.map((item) => {
      const catalogItem = getHubCatalogItemFromDb(item.slug);
      return {
        ...item,
        name: catalogItem?.name ?? item.slug,
        description: catalogItem?.description ?? null,
        emoji: catalogItem?.emoji ?? null,
        catalogVersion: catalogItem?.version ?? null,
        hasUpdate:
          catalogItem?.version != null && catalogItem.version !== item.version
            ? catalogItem.version
            : null,
      };
    });

    respond(true, { items: enriched }, undefined);
  },

  // ── hub.updates ───────────────────────────────────────────────────────────
  "hub.updates": ({ respond }) => {
    const installed = getAllHubInstalledFromDb();
    const updates = installed
      .map((item) => {
        const catalogItem = getHubCatalogItemFromDb(item.slug);
        if (!catalogItem || catalogItem.version === item.version) {
          return null;
        }
        return {
          slug: item.slug,
          name: catalogItem.name,
          type: item.type,
          installedVersion: item.version,
          availableVersion: catalogItem.version,
          emoji: catalogItem.emoji,
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    respond(true, { updates }, undefined);
  },

  // ── hub.collections ───────────────────────────────────────────────────────
  "hub.collections": ({ respond }) => {
    const collections = getHubCollectionsFromDb();

    // Enrich each collection with item metadata
    const enriched = collections.map((col) => ({
      ...col,
      items: col.items.map((slug) => {
        const item = getHubCatalogItemFromDb(slug);
        return item
          ? {
              slug,
              name: item.name,
              type: item.type,
              emoji: item.emoji,
              bundled: item.bundled,
              installed: getHubInstalledItemFromDb(slug) !== null,
            }
          : { slug, name: slug, type: null, emoji: null, bundled: false, installed: false };
      }),
    }));

    respond(true, { collections: enriched }, undefined);
  },

  // ── hub.installCollection ─────────────────────────────────────────────────
  "hub.installCollection": async ({ params, respond }) => {
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }

    const collections = getHubCollectionsFromDb();
    const collection = collections.find((c) => c.slug === slug);
    if (!collection) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `collection "${slug}" not found`),
      );
      return;
    }

    // Install each item in the collection (skip already-installed and bundled)
    const results: Array<{
      slug: string;
      status: "installed" | "skipped" | "bundled" | "error";
      message?: string;
    }> = [];

    for (const itemSlug of collection.items) {
      const item = getHubCatalogItemFromDb(itemSlug);
      if (!item) {
        results.push({ slug: itemSlug, status: "skipped", message: "not in catalog" });
        continue;
      }
      if (item.bundled) {
        results.push({ slug: itemSlug, status: "bundled" });
        continue;
      }
      if (getHubInstalledItemFromDb(itemSlug)) {
        results.push({ slug: itemSlug, status: "skipped", message: "already installed" });
        continue;
      }

      // Delegate to hub.install logic inline
      const resolved = resolveWorkspace(params);
      if ("error" in resolved) {
        results.push({ slug: itemSlug, status: "error", message: resolved.error });
        continue;
      }
      const { workspaceDir, agentId } = resolved;

      let installDir: string;
      let installPath: string;
      if (item.type === "skill") {
        installDir = path.join(workspaceDir, "skills", itemSlug);
        installPath = path.join(installDir, "SKILL.md");
      } else if (item.type === "agent") {
        installDir = path.join(workspaceDir, "agents");
        installPath = path.join(installDir, `${itemSlug}.md`);
      } else {
        const stateDir = resolveStateDir(process.env);
        installDir = path.join(stateDir, "commands");
        installPath = path.join(installDir, `${itemSlug}.md`);
      }

      const hubUrl = resolveHubUrl();
      const baseUrl = resolveHubBaseUrl(hubUrl);
      const contentUrl = resolveContentUrl(baseUrl, item.path);

      let content: string;
      try {
        content = await fetchUrl(contentUrl);
      } catch (err) {
        results.push({
          slug: itemSlug,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (item.sha256 && !verifySha256(content, item.sha256)) {
        results.push({
          slug: itemSlug,
          status: "error",
          message: "SHA-256 integrity check failed",
        });
        continue;
      }

      try {
        fs.mkdirSync(installDir, { recursive: true });
        fs.writeFileSync(installPath, content, "utf-8");
      } catch (err) {
        results.push({
          slug: itemSlug,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      insertHubInstalledInDb({
        slug: itemSlug,
        type: item.type,
        version: item.version,
        installPath,
        agentId: item.type === "command" ? null : agentId,
      });
      results.push({ slug: itemSlug, status: "installed" });
    }

    const installed = results.filter((r) => r.status === "installed").length;
    const skipped = results.filter((r) => r.status === "skipped" || r.status === "bundled").length;
    const errors = results.filter((r) => r.status === "error").length;

    respond(true, { collection: slug, installed, skipped, errors, results }, undefined);
  },
};
