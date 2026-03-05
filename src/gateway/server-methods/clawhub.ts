import { execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { promisify } from "node:util";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

// ─── Path Resolver ────────────────────────────────────────────────────────────

export function resolveClawHubPaths(workspaceDir: string) {
  const clawhubDir = path.join(workspaceDir, ".openclaw", "clawhub");
  return {
    clawhubDir,
    catalogPath: path.join(clawhubDir, "catalog.json"),
    previewsDir: path.join(clawhubDir, "previews"),
    lockPath: path.join(clawhubDir, "clawhub.lock.json"),
    skillsDir: path.join(workspaceDir, "skills"),
  };
}

function ensureClawHubDirs(workspaceDir: string) {
  const { clawhubDir, previewsDir } = resolveClawHubPaths(workspaceDir);
  fs.mkdirSync(clawhubDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });
}

// ─── Category Derivation ──────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  development: [
    "github",
    "git",
    "code",
    "deploy",
    "api",
    "cli",
    "dev",
    "pull request",
    "commit",
    "npm",
    "docker",
    "typescript",
    "python",
    "sdk",
    "plugin",
    "ci/cd",
  ],
  productivity: [
    "task",
    "todo",
    "briefing",
    "plan",
    "workflow",
    "reminder",
    "calendar",
    "memory",
    "note",
    "form",
    "pdf",
    "intake",
    "learning",
    "habit",
  ],
  social: [
    "twitter",
    "telegram",
    "discord",
    "social",
    "post",
    "mastodon",
    "bluesky",
    "toutiao",
    "weibo",
    "reddit",
    "linkedin",
    "instagram",
    "tweet",
    "kol",
    "rss",
    "feed",
    "x.com",
  ],
  automation: [
    "automate",
    "cron",
    "schedule",
    "trigger",
    "monitor",
    "webhook",
    "bot",
    "dispatch",
    "router",
    "agent deploy",
    "runner",
  ],
  media: [
    "video",
    "audio",
    "image",
    "youtube",
    "music",
    "transcribe",
    "photo",
    "publish",
    "podcast",
    "stream",
    "recording",
  ],
  utility: [
    "weather",
    "search",
    "summarize",
    "translate",
    "convert",
    "calculate",
    "generate",
    "extract",
    "analyze",
    "security",
    "guard",
    "protect",
    "scanner",
  ],
  communication: [
    "message",
    "chat",
    "email",
    "notify",
    "alert",
    "sms",
    "slack",
    "thread",
    "channel",
    "whatsapp",
    "teams",
    "im ",
    "messaging",
    "agentgram",
  ],
  data: [
    "data",
    "analytics",
    "metrics",
    "report",
    "dashboard",
    "database",
    "sql",
    "spreadsheet",
    "csv",
    "etl",
  ],
  finance: [
    "crypto",
    "trading",
    "binance",
    "stock",
    "price",
    "market",
    "portfolio",
    "defi",
    "token",
    "solana",
    "nft",
    "wallet",
    "broker",
    "yield",
    "trade",
    "prime broker",
    "消费",
    "финансов",
  ],
};

export function deriveCategories(skill: {
  summary?: string;
  displayName?: string;
  slug?: string;
}): { category: string; categories: string[] } {
  const text =
    `${skill.summary ?? ""} ${skill.displayName ?? ""} ${skill.slug ?? ""}`.toLowerCase();
  const scores = Object.entries(CATEGORY_KEYWORDS).map(([cat, keywords]) => ({
    cat,
    score: keywords.filter((kw) => text.includes(kw)).length,
  }));
  const matched = scores.filter((s) => s.score > 0).toSorted((a, b) => b.score - a.score);
  const categories = matched.map((s) => s.cat);
  return {
    category: categories[0] ?? "other",
    categories: categories.length ? categories : ["other"],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const STALE_MS = 24 * 60 * 60 * 1000; // 24 h
const CLAWHUB_REGISTRY = "https://clawhub.ai";
const CLAWHUB_SKILLS_PATH = "/api/v1/skills";
const PAGE_SIZE = 200; // max per page the API supports

function isCatalogStale(syncedAt: string | undefined): boolean {
  if (!syncedAt) {
    return true;
  }
  return Date.now() - new Date(syncedAt).getTime() > STALE_MS;
}

/** Fetch a single page from the ClawHub registry API. */
function fetchSkillsPage(
  cursor?: string,
): Promise<{ items: unknown[]; nextCursor: string | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(CLAWHUB_SKILLS_PATH, CLAWHUB_REGISTRY);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const req = https.get(
      url.toString(),
      { headers: { "User-Agent": "openclaw-gateway/1.0" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(body) as { items?: unknown[]; nextCursor?: string | null };
            resolve({
              items: Array.isArray(parsed.items) ? parsed.items : [],
              nextCursor: parsed.nextCursor ?? null,
            });
          } catch (e) {
            reject(new Error(`Failed to parse ClawHub API response: ${String(e)}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error("ClawHub API request timed out"));
    });
  });
}

/** Fetch ALL skills from the ClawHub registry by paginating through all pages. */
async function fetchAllSkills(): Promise<unknown[]> {
  const allItems: unknown[] = [];
  let cursor: string | undefined;
  // Safety cap: 15,000 skills / 200 per page = 75 pages max; allow up to 100
  const MAX_PAGES = 100;
  let page = 0;

  do {
    const result = await fetchSkillsPage(cursor);
    allItems.push(...result.items);
    cursor = result.nextCursor ?? undefined;
    page++;
  } while (cursor && page < MAX_PAGES);

  return allItems;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export const clawhubHandlers: GatewayRequestHandlers = {
  // ── clawhub.sync ────────────────────────────────────────────────────────────
  "clawhub.sync": async ({ params, respond }) => {
    const resolved = resolveWorkspace(params);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const { workspaceDir } = resolved;
    ensureClawHubDirs(workspaceDir);
    const paths = resolveClawHubPaths(workspaceDir);

    // Fetch all skills from the ClawHub registry via paginated API calls.
    // The `clawhub explore` CLI is capped at 200; direct API pagination gets all ~15k skills.
    let rawSkills: unknown[];
    try {
      rawSkills = await fetchAllSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `Failed to fetch skills from ClawHub registry: ${msg}`),
      );
      return;
    }

    // Load existing catalog to compute diffs
    let prevSkills: Record<string, unknown> = {};
    try {
      if (fs.existsSync(paths.catalogPath)) {
        const prev = JSON.parse(fs.readFileSync(paths.catalogPath, "utf8")) as {
          skills?: Array<{ slug?: string; latestVersion?: { version?: string } }>;
        };
        for (const s of prev.skills ?? []) {
          if (s.slug) {
            prevSkills[s.slug] = s;
          }
        }
      }
    } catch {
      /* ignore */
    }

    let newSkills = 0;
    let updatedSkills = 0;
    let stalePreviewsInvalidated = 0;

    const skills = (rawSkills as Array<Record<string, unknown>>).map((s) => {
      const slug = typeof s.slug === "string" ? s.slug : "";
      const { category, categories } = deriveCategories({
        summary: typeof s.summary === "string" ? s.summary : "",
        displayName: typeof s.displayName === "string" ? s.displayName : "",
        slug,
      });

      const prev = prevSkills[slug] as { latestVersion?: { version?: string } } | undefined;
      const newVersion = (s.latestVersion as { version?: string } | undefined)?.version;
      const prevVersion = prev?.latestVersion?.version;

      if (!prev) {
        newSkills++;
      } else if (newVersion && prevVersion && newVersion !== prevVersion) {
        updatedSkills++;
        // Invalidate preview cache for this skill
        const previewPath = path.join(paths.previewsDir, `${slug}.json`);
        if (fs.existsSync(previewPath)) {
          fs.unlinkSync(previewPath);
          stalePreviewsInvalidated++;
        }
      }

      return { ...s, slug, category, categories };
    });

    const syncedAt = new Date().toISOString();
    const catalog = { syncedAt, totalSkills: skills.length, skills };
    fs.writeFileSync(paths.catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    respond(
      true,
      {
        syncedAt,
        catalogPath: paths.catalogPath,
        totalSkills: skills.length,
        newSkills,
        updatedSkills,
        stalePreviewsInvalidated,
      },
      undefined,
    );
  },

  // ── clawhub.catalog ─────────────────────────────────────────────────────────
  "clawhub.catalog": ({ params, respond }) => {
    const p = params;
    const resolved = resolveWorkspace(p);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const paths = resolveClawHubPaths(resolved.workspaceDir);

    if (!fs.existsSync(paths.catalogPath)) {
      respond(true, { syncedAt: null, stale: true, total: 0, filtered: 0, skills: [] }, undefined);
      return;
    }

    let catalog: { syncedAt?: string; skills?: Array<Record<string, unknown>> };
    try {
      catalog = JSON.parse(fs.readFileSync(paths.catalogPath, "utf8"));
    } catch {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "failed to read catalog.json"));
      return;
    }

    const stale = isCatalogStale(catalog.syncedAt);
    let skills = catalog.skills ?? [];

    // Filter by category
    const category = typeof p.category === "string" && p.category !== "all" ? p.category : null;
    if (category) {
      skills = skills.filter((s) => {
        const cats = Array.isArray(s.categories) ? s.categories : [s.category];
        return cats.includes(category);
      });
    }

    // Text search
    const search = typeof p.search === "string" ? p.search.toLowerCase().trim() : "";
    if (search) {
      skills = skills.filter((s) => {
        const name = typeof s.displayName === "string" ? s.displayName.toLowerCase() : "";
        const summary = typeof s.summary === "string" ? s.summary.toLowerCase() : "";
        const slug = typeof s.slug === "string" ? s.slug.toLowerCase() : "";
        return name.includes(search) || summary.includes(search) || slug.includes(search);
      });
    }

    // Sort
    const sort = typeof p.sort === "string" ? p.sort : "downloads";
    skills = [...skills].toSorted((a, b) => {
      const sa = a.stats as Record<string, number> | undefined;
      const sb = b.stats as Record<string, number> | undefined;
      if (sort === "stars") {
        return (sb?.stars ?? 0) - (sa?.stars ?? 0);
      }
      if (sort === "installs") {
        return (sb?.installsCurrent ?? 0) - (sa?.installsCurrent ?? 0);
      }
      if (sort === "newest") {
        const va = (a.latestVersion as { version?: string } | undefined)?.version ?? "";
        const vb = (b.latestVersion as { version?: string } | undefined)?.version ?? "";
        return vb.localeCompare(va);
      }
      // default: downloads
      return (sb?.downloads ?? 0) - (sa?.downloads ?? 0);
    });

    respond(
      true,
      {
        syncedAt: catalog.syncedAt ?? null,
        stale,
        total: (catalog.skills ?? []).length,
        filtered: skills.length,
        skills,
      },
      undefined,
    );
  },

  // ── clawhub.inspect ─────────────────────────────────────────────────────────
  "clawhub.inspect": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveWorkspace(p);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const slug = typeof p.slug === "string" ? p.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }
    const paths = resolveClawHubPaths(resolved.workspaceDir);
    ensureClawHubDirs(resolved.workspaceDir);

    // Determine expected version from catalog
    let expectedVersion: string | null = null;
    try {
      if (fs.existsSync(paths.catalogPath)) {
        const catalog = JSON.parse(fs.readFileSync(paths.catalogPath, "utf8")) as {
          skills?: Array<{ slug?: string; latestVersion?: { version?: string } }>;
        };
        const entry = (catalog.skills ?? []).find((s) => s.slug === slug);
        expectedVersion = entry?.latestVersion?.version ?? null;
      }
    } catch {
      /* ignore */
    }

    // Check preview cache
    const previewPath = path.join(paths.previewsDir, `${slug}.json`);
    if (fs.existsSync(previewPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(previewPath, "utf8")) as {
          slug: string;
          version: string;
          fetchedAt: string;
          content: string;
        };
        if (!expectedVersion || cached.version === expectedVersion) {
          respond(true, cached, undefined);
          return;
        }
      } catch {
        /* stale/corrupt, refetch */
      }
    }

    // Fetch from clawhub CLI — try SKILL.md first, then README.md, then readme.md
    // Some skills use README.md instead of SKILL.md; fall through until we get content.
    const CANDIDATE_FILES = ["SKILL.md", "README.md", "readme.md"];
    let content = "";
    let binaryMissing = false;
    for (const filename of CANDIDATE_FILES) {
      try {
        const { stdout } = await execFileAsync("clawhub", ["inspect", slug, "--file", filename], {
          timeout: 30_000,
        });
        if (stdout.trim()) {
          content = stdout;
          break;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT")) {
          // clawhub binary itself is missing — no point trying other files
          binaryMissing = true;
          break;
        }
        // "File not found" from clawhub means this filename doesn't exist in the skill — try next
      }
    }
    if (binaryMissing) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "clawhub binary not found. Install it from https://clawhub.ai",
        ),
      );
      return;
    }

    const envelope = {
      slug,
      version: expectedVersion ?? "unknown",
      fetchedAt: new Date().toISOString(),
      content,
    };
    fs.writeFileSync(previewPath, JSON.stringify(envelope, null, 2), "utf8");
    respond(true, envelope, undefined);
  },

  // ── clawhub.download ────────────────────────────────────────────────────────
  "clawhub.download": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveWorkspace(p);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const slug = typeof p.slug === "string" ? p.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }
    const { workspaceDir } = resolved;
    const paths = resolveClawHubPaths(workspaceDir);
    ensureClawHubDirs(workspaceDir);
    fs.mkdirSync(paths.skillsDir, { recursive: true });

    try {
      await execFileAsync("clawhub", ["install", slug, "--dir", paths.skillsDir], {
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stderr = (err as { stderr?: string }).stderr ?? "";
      if (msg.includes("ENOENT") || msg.includes("not found")) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "clawhub binary not found. Install it from https://clawhub.ai",
          ),
        );
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `clawhub install failed: ${stderr || msg}`),
        );
      }
      return;
    }

    const installedAt = path.join(paths.skillsDir, slug);
    respond(
      true,
      {
        ok: true,
        slug,
        installedAt,
        requiresRestart: true,
        message: "Skill installed. It will be active after the next session restart.",
      },
      undefined,
    );
  },

  // ── clawhub.uninstall ───────────────────────────────────────────────────────
  "clawhub.uninstall": async ({ params, respond }) => {
    const p = params;
    const resolved = resolveWorkspace(p);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const slug = typeof p.slug === "string" ? p.slug.trim() : "";
    if (!slug) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "slug is required"));
      return;
    }
    const paths = resolveClawHubPaths(resolved.workspaceDir);
    const skillDir = path.join(paths.skillsDir, slug);

    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    // Remove from lockfile
    if (fs.existsSync(paths.lockPath)) {
      try {
        const lock = JSON.parse(fs.readFileSync(paths.lockPath, "utf8")) as Record<string, unknown>;
        delete lock[slug];
        fs.writeFileSync(paths.lockPath, JSON.stringify(lock, null, 2), "utf8");
      } catch {
        /* ignore if corrupt */
      }
    }

    respond(true, { ok: true, slug }, undefined);
  },

  // ── clawhub.installed ───────────────────────────────────────────────────────
  "clawhub.installed": ({ params, respond }) => {
    const p = params;
    const resolved = resolveWorkspace(p);
    if ("error" in resolved) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolved.error));
      return;
    }
    const paths = resolveClawHubPaths(resolved.workspaceDir);

    // Read lock file for version info
    let lockData: Record<string, { version?: string }> = {};
    if (fs.existsSync(paths.lockPath)) {
      try {
        lockData = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
      } catch {
        /* ignore */
      }
    }

    // Cross-reference with skills/ folder
    let installedSlugs: string[] = [];
    if (fs.existsSync(paths.skillsDir)) {
      try {
        installedSlugs = fs
          .readdirSync(paths.skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        /* ignore */
      }
    }

    // Enrich with catalog metadata
    let catalogSkills: Array<Record<string, unknown>> = [];
    if (fs.existsSync(paths.catalogPath)) {
      try {
        const catalog = JSON.parse(fs.readFileSync(paths.catalogPath, "utf8")) as {
          skills?: Array<Record<string, unknown>>;
        };
        catalogSkills = catalog.skills ?? [];
      } catch {
        /* ignore */
      }
    }
    const catalogBySlug = new Map(catalogSkills.map((s) => [s.slug as string, s]));

    const skills = installedSlugs.map((slug) => ({
      slug,
      installedVersion: lockData[slug]?.version ?? null,
      ...catalogBySlug.get(slug),
    }));

    respond(true, { skills }, undefined);
  },
};
