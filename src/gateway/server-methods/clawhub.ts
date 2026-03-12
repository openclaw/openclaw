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
import {
  deleteLockEntryFromDb,
  deleteSkillPreviewFromDb,
  getAllLockEntriesFromDb,
  getCatalogSkillsFromDb,
  getCatalogSkillVersionFromDb,
  getClawhubSyncMeta,
  getSkillPreviewFromDb,
  replaceCatalogInDb,
  setClawhubSyncMeta,
  setSkillPreviewInDb,
} from "../../infra/state-db/clawhub-sqlite.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

// ─── Path Resolver ────────────────────────────────────────────────────────────

export function resolveClawHubPaths(workspaceDir: string) {
  return {
    skillsDir: path.join(workspaceDir, "skills"),
  };
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

    // Load existing catalog from SQLite to compute diffs
    const prevCatalog = getCatalogSkillsFromDb(workspaceDir);
    const prevSkills: Record<string, Record<string, unknown>> = {};
    for (const s of prevCatalog) {
      const slug = typeof s.slug === "string" ? s.slug : "";
      if (slug) {
        prevSkills[slug] = s;
      }
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
        if (deleteSkillPreviewFromDb(workspaceDir, slug)) {
          stalePreviewsInvalidated++;
        }
      }

      return { ...s, slug, category, categories };
    });

    const syncedAt = new Date().toISOString();
    replaceCatalogInDb(workspaceDir, skills);
    setClawhubSyncMeta(workspaceDir, { syncedAt, totalSkills: skills.length });

    respond(
      true,
      {
        syncedAt,
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
    const { workspaceDir } = resolved;

    const syncMeta = getClawhubSyncMeta(workspaceDir);
    const allSkills = getCatalogSkillsFromDb(workspaceDir);

    if (!syncMeta) {
      respond(true, { syncedAt: null, stale: true, total: 0, filtered: 0, skills: [] }, undefined);
      return;
    }

    const stale = isCatalogStale(syncMeta.syncedAt);
    let skills = allSkills;

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
        syncedAt: syncMeta.syncedAt,
        stale,
        total: allSkills.length,
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
    const { workspaceDir } = resolved;

    // Determine expected version from catalog
    const expectedVersion = getCatalogSkillVersionFromDb(workspaceDir, slug);

    // Check preview cache in SQLite
    const cached = getSkillPreviewFromDb(workspaceDir, slug);
    if (cached) {
      if (!expectedVersion || cached.version === expectedVersion) {
        respond(true, cached, undefined);
        return;
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
    setSkillPreviewInDb(workspaceDir, envelope);
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
    const { skillsDir } = resolveClawHubPaths(workspaceDir);
    fs.mkdirSync(skillsDir, { recursive: true });

    try {
      await execFileAsync("clawhub", ["install", slug, "--dir", skillsDir], {
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

    const installedAt = path.join(skillsDir, slug);
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
    const { skillsDir } = resolveClawHubPaths(resolved.workspaceDir);
    const skillDir = path.join(skillsDir, slug);

    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    // Remove from lock table
    deleteLockEntryFromDb(resolved.workspaceDir, slug);

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
    const { workspaceDir } = resolved;
    const { skillsDir } = resolveClawHubPaths(workspaceDir);

    // Read lock entries from SQLite
    const lockData = getAllLockEntriesFromDb(workspaceDir);

    // Cross-reference with skills/ folder
    let installedSlugs: string[] = [];
    if (fs.existsSync(skillsDir)) {
      try {
        installedSlugs = fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        /* ignore */
      }
    }

    // Enrich with catalog metadata from SQLite
    const catalogSkills = getCatalogSkillsFromDb(workspaceDir);
    const catalogBySlug = new Map(catalogSkills.map((s) => [s.slug as string, s]));

    const skills = installedSlugs.map((slug) => ({
      slug,
      installedVersion: lockData[slug]?.version ?? null,
      ...catalogBySlug.get(slug),
    }));

    respond(true, { skills }, undefined);
  },
};
