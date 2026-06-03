import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@mariozechner/pi-coding-agent";
import mysql from "mysql2/promise";
import { createSyntheticSourceInfo } from "../agents/skills/skill-contract.js";
import type { SourceScope } from "../agents/skills/skill-contract.js";
import type {
  SkillEntry,
  ParsedSkillFrontmatter,
  OpenClawSkillMetadata,
  SkillInvocationPolicy,
  SkillExposure,
} from "../agents/skills/types.js";
import { loadConfig } from "../config/config.js";

export interface SkillRow {
  id: number;
  user_id: number | null;
  name: string;
  description: string | null;
  content: string | null;
  source: string;
  category: string | null;
  is_enable: number;
  references: string | null;
  scripts: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let pool: mysql.Pool | null = null;
let cachedEntries: SkillEntry[] | null = null;
let cacheLoadTime = 0;
const CACHE_TTL_MS = 5000;

function resolveConfig(): MySqlConfig {
  const cfg = loadConfig();
  const pluginEntries = cfg.plugins?.entries as Record<string, Record<string, unknown>> | undefined;
  const mysqlCfg = pluginEntries?.["feed-search"]?.config as Record<string, unknown> | undefined;
  const env = process.env;

  // Skills live in the same `superworker` DB the rabbitmq-consumer reads, which
  // is configured via HISTORY_MYSQL_*. Prefer those, then the older FEED_MYSQL_*
  // names, then the local default. Without this, a missing FEED_MYSQL_* config
  // silently fell back to 127.0.0.1 and failed with "Access denied".
  return {
    host:
      (mysqlCfg?.host as string) ?? env.HISTORY_MYSQL_HOST ?? env.FEED_MYSQL_HOST ?? "127.0.0.1",
    port: Number(mysqlCfg?.port ?? env.HISTORY_MYSQL_PORT ?? env.FEED_MYSQL_PORT ?? 3306),
    user: (mysqlCfg?.user as string) ?? env.HISTORY_MYSQL_USER ?? env.FEED_MYSQL_USER ?? "",
    password:
      (mysqlCfg?.password as string) ?? env.HISTORY_MYSQL_PASSWORD ?? env.FEED_MYSQL_PASSWORD ?? "",
    database:
      (mysqlCfg?.database as string) ??
      env.HISTORY_MYSQL_DATABASE ??
      env.FEED_MYSQL_DATABASE ??
      "superworker",
  };
}

function getPool(): mysql.Pool {
  if (pool) {
    return pool;
  }

  const config = resolveConfig();
  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "+08:00",
    // Fail fast instead of hanging the turn when the DB is unreachable.
    connectTimeout: 5000,
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  cachedEntries = null;
}

export async function refreshSkillsCache(userId?: number): Promise<void> {
  const p = getPool();
  const query =
    userId !== undefined
      ? "SELECT id, user_id, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE is_enable = 1 AND user_id = ? ORDER BY name ASC"
      : "SELECT id, user_id, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE is_enable = 1 ORDER BY name ASC";
  const [rows] =
    userId !== undefined
      ? await p.execute<mysql.RowDataPacket[]>(query, [userId])
      : await p.execute<mysql.RowDataPacket[]>(query);
  cachedEntries = (rows as SkillRow[]).map((row) => rowToSkillEntry(row));
  cacheLoadTime = Date.now();
}

function rowToSkillEntry(
  row: SkillRow,
  realPaths?: { filePath: string; baseDir: string },
): SkillEntry {
  const name = row.name ?? "";
  const description = row.description ?? "";
  // Materialized skills point at real workspace files so `read`/`exec` work;
  // non-materialized callers (listings/CRUD) get the virtual `memory://` path.
  const filePath = realPaths?.filePath ?? `memory://skills/${name}/SKILL.md`;
  const baseDir = realPaths?.baseDir ?? `memory://skills/${name}`;

  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir,
    source: row.source ?? "db",
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: row.source ?? "db",
      scope: "project" as SourceScope,
      origin: "top-level",
      baseDir,
    }),
    disableModelInvocation: false,
  };

  const frontmatter: ParsedSkillFrontmatter = {
    name,
    description,
  };

  const metadata: OpenClawSkillMetadata | undefined = row.category ? { emoji: "📋" } : undefined;

  const invocation: SkillInvocationPolicy = {
    userInvocable: true,
    disableModelInvocation: false,
  };

  const exposure: SkillExposure = {
    includeInRuntimeRegistry: true,
    includeInAvailableSkillsPrompt: true,
    userInvocable: true,
  };

  return { skill, frontmatter, metadata, invocation, exposure };
}

export async function preloadSkillsCache(userId?: string): Promise<void> {
  const numericUserId = userId ? Number(userId) : undefined;
  await refreshSkillsCache(numericUserId);
  syncCache = cachedEntries;
  cachedUserId = numericUserId;
}

// Sync version for loadSkillEntriesFromDb caller
let syncCache: SkillEntry[] | null = null;
let cachedUserId: number | undefined = undefined;

export function loadSkillEntriesFromDb(_userId?: string): SkillEntry[] {
  return syncCache ?? [];
}

export async function loadSkillEntriesFromDbAsync(userId?: string): Promise<SkillEntry[]> {
  const numericUserId = userId ? Number(userId) : undefined;
  if (
    !cachedEntries ||
    Date.now() - cacheLoadTime > CACHE_TTL_MS ||
    cachedUserId !== numericUserId
  ) {
    await refreshSkillsCache(numericUserId);
    syncCache = cachedEntries;
    cachedUserId = numericUserId;
  }
  return cachedEntries ?? [];
}

export async function listSkills(
  userId: number,
  opts?: { limit?: number; offset?: number },
): Promise<{ skills: SkillRow[]; total: number }> {
  const p = getPool();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const [countRows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as total FROM skills WHERE user_id = ?",
    [userId],
  );
  const total = (countRows[0] as { total: number }).total ?? 0;

  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE user_id = ? ORDER BY name ASC LIMIT ? OFFSET ?",
    [userId, limit, offset],
  );

  return { skills: rows as SkillRow[], total };
}

export async function getSkillById(id: number, userId: number): Promise<SkillRow | null> {
  const p = getPool();
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return (rows[0] as SkillRow) ?? null;
}

export async function createSkill(
  data: {
    name: string;
    description?: string;
    content?: string;
    source?: string;
    category?: string;
  },
  userId: number,
): Promise<SkillRow> {
  const p = getPool();
  const now = new Date();
  const [result] = await p.execute<mysql.ResultSetHeader>(
    "INSERT INTO skills (user_id, name, description, content, source, category, is_enable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    [
      userId,
      data.name,
      data.description ?? null,
      data.content ?? null,
      data.source ?? "manual",
      data.category ?? null,
      now,
      now,
    ],
  );
  const inserted = await getSkillById(result.insertId, userId);
  if (!inserted) {
    throw new Error("Failed to retrieve inserted skill");
  }
  return inserted;
}

export async function updateSkill(
  id: number,
  data: Partial<{
    name: string;
    description: string;
    content: string;
    source: string;
    category: string;
    is_enable: number;
  }>,
  userId: number,
): Promise<SkillRow | null> {
  const p = getPool();
  const sets: string[] = [];
  const values: (string | number | null | Date)[] = [];

  if (data.name !== undefined) {
    sets.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    sets.push("description = ?");
    values.push(data.description);
  }
  if (data.content !== undefined) {
    sets.push("content = ?");
    values.push(data.content);
  }
  if (data.source !== undefined) {
    sets.push("source = ?");
    values.push(data.source);
  }
  if (data.category !== undefined) {
    sets.push("category = ?");
    values.push(data.category);
  }
  if (data.is_enable !== undefined) {
    sets.push("is_enable = ?");
    values.push(data.is_enable);
  }

  if (sets.length === 0) {
    return getSkillById(id, userId);
  }

  sets.push("updated_at = ?");
  values.push(new Date());

  const queryValues: (string | number | boolean | null | Date)[] = [...values, id, userId];
  await p.execute(`UPDATE skills SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, queryValues);

  return getSkillById(id, userId);
}

export async function deleteSkill(id: number, userId: number): Promise<boolean> {
  const p = getPool();
  const [result] = await p.execute<mysql.ResultSetHeader>(
    "DELETE FROM skills WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Skill script materialization
//
// DB skills are catalog-only until their SKILL.md body (`skills.content`) and
// their linked executable scripts (`skill_scripts.script_content`) are written
// to a real workspace directory. Once materialized to
// `<workspaceDir>/skills/<name>/`, the agent's existing `read`/`exec`/`bash`
// tools can load and run them exactly like native OpenClaw skill bundles.
// ---------------------------------------------------------------------------

export interface SkillScriptRow {
  id: number;
  skill_id: number;
  script_name: string;
  script_content: string | null;
  language: string | null;
}

/** Fetch all skill scripts for the given skill ids, grouped by skill_id. */
export async function fetchSkillScripts(
  skillIds: number[],
): Promise<Map<number, SkillScriptRow[]>> {
  const map = new Map<number, SkillScriptRow[]>();
  if (skillIds.length === 0) {
    return map;
  }
  const p = getPool();
  const placeholders = skillIds.map(() => "?").join(",");
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    `SELECT id, skill_id, script_name, script_content, language FROM skill_scripts WHERE skill_id IN (${placeholders}) ORDER BY id ASC`,
    skillIds,
  );
  for (const row of rows as SkillScriptRow[]) {
    const arr = map.get(row.skill_id) ?? [];
    arr.push(row);
    map.set(row.skill_id, arr);
  }
  return map;
}

/**
 * Reduce a DB-provided name to a single safe path segment: strip directories,
 * reject traversal/empty, and keep only filename-safe characters. Prevents a
 * malicious/typo'd `skills.name` or `skill_scripts.script_name` from escaping
 * the skills directory via `../` or absolute paths.
 */
export function sanitizeSkillSegment(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const base = path.basename(value.replaceAll("\\", "/").trim());
  if (!base || base === "." || base === "..") {
    return "";
  }
  return base.replaceAll(/[^\w.-]/g, "_");
}

// Skip re-fetching/re-writing within a short window for the same (user, workspace).
let materializedKey: string | null = null;
let materializedAt = 0;
// After a failure (DB down/misconfigured), back off so we do not retry — and
// re-block — the turn path on every message.
let lastFailureAt = 0;
const FAILURE_COOLDOWN_MS = 60_000;
// Hard ceiling on how long skill materialization may add to a turn.
const MATERIALIZE_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Resolve the integer skills `user_id` for a run from its sessionKey/agentId.
 * Guardian sessionKeys look like `agent:<agentId>:<channel>:<userId>:<sessionId>`
 * (e.g. `agent:rabbitmq-1749:rabbitmq:1749:session_...`); falls back to the
 * trailing number of an agentId such as `rabbitmq-1749`.
 */
export function resolveSkillUserId(sessionKey?: string, agentId?: string): string | undefined {
  if (sessionKey) {
    const parts = sessionKey.split(":");
    if (parts[0] === "agent" && parts.length >= 4 && /^\d+$/.test(parts[3] ?? "")) {
      return parts[3];
    }
  }
  const trailing = agentId?.match(/-(\d+)$/)?.[1];
  return trailing ?? undefined;
}

/**
 * Fetch the user's enabled skills, write each skill's SKILL.md and linked
 * scripts into `<workspaceDir>/skills/<name>/`, prime the in-process cache with
 * real-path entries, and return them. Safe to call every turn: it short-circuits
 * within `CACHE_TTL_MS` for the same (user, workspace).
 */
export async function materializeSkillsForUser(
  workspaceDir: string,
  userId?: string,
): Promise<SkillEntry[]> {
  const numericUserId = userId ? Number(userId) : undefined;
  if (numericUserId === undefined || Number.isNaN(numericUserId)) {
    return [];
  }

  const key = `${numericUserId}::${workspaceDir}`;
  if (key === materializedKey && Date.now() - materializedAt < CACHE_TTL_MS && cachedEntries) {
    return cachedEntries;
  }

  // Recently failed (DB unreachable/misconfigured): skip without re-blocking the
  // turn. Degrade to whatever was last materialized, or to filesystem skills.
  if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    return cachedEntries ?? [];
  }

  try {
    return await withTimeout(
      doMaterializeSkills(workspaceDir, numericUserId, key),
      MATERIALIZE_TIMEOUT_MS,
      "skills materialize",
    );
  } catch (err) {
    lastFailureAt = Date.now();
    throw err;
  }
}

async function doMaterializeSkills(
  workspaceDir: string,
  numericUserId: number,
  key: string,
): Promise<SkillEntry[]> {
  const p = getPool();
  const [rows] = await p.execute<mysql.RowDataPacket[]>(
    "SELECT id, user_id, name, description, content, source, category, is_enable, `references`, scripts, created_at, updated_at FROM skills WHERE is_enable = 1 AND user_id = ? ORDER BY name ASC",
    [numericUserId],
  );
  const skillRows = rows as SkillRow[];
  const scriptsBySkill = await fetchSkillScripts(skillRows.map((r) => r.id));

  const skillsRoot = path.join(workspaceDir, "skills");
  const entries: SkillEntry[] = [];
  for (const row of skillRows) {
    const safeName = sanitizeSkillSegment(row.name);
    if (!safeName) {
      continue;
    }
    const baseDir = path.join(skillsRoot, safeName);
    await fs.mkdir(baseDir, { recursive: true });
    const skillMdPath = path.join(baseDir, "SKILL.md");
    await fs.writeFile(skillMdPath, row.content ?? "", "utf8");

    for (const script of scriptsBySkill.get(row.id) ?? []) {
      const safeScript = sanitizeSkillSegment(script.script_name);
      if (!safeScript) {
        continue;
      }
      const scriptPath = path.join(baseDir, safeScript);
      await fs.writeFile(scriptPath, script.script_content ?? "", "utf8");
      if (process.platform !== "win32") {
        try {
          await fs.chmod(scriptPath, 0o755);
        } catch {
          // best-effort executable bit; non-fatal on filesystems that reject chmod
        }
      }
    }

    entries.push(rowToSkillEntry(row, { filePath: skillMdPath, baseDir }));
  }

  cachedEntries = entries;
  syncCache = entries;
  cachedUserId = numericUserId;
  cacheLoadTime = Date.now();
  materializedKey = key;
  materializedAt = Date.now();
  lastFailureAt = 0;
  return entries;
}
