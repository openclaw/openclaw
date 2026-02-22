import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { deriveQmdScopeChannel, deriveQmdScopeChatType, isQmdScopeAllowed } from "./qmd-scope.js";
import {
  listSessionFilesForAgent,
  buildSessionEntry,
  type SessionFileEntry,
} from "./session-files.js";
import { requireNodeSqlite } from "./sqlite.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;
import type {
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "./backend-config.js";
import { parseQmdQueryJson, type QmdQueryResult } from "./qmd-query-parser.js";
import { extractKeywords } from "./query-expansion.js";

const log = createSubsystemLogger("memory");

const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;
const SEARCH_PENDING_UPDATE_WAIT_MS = 500;
const MAX_QMD_OUTPUT_CHARS = 200_000;
const NUL_MARKER_RE = /(?:\^@|\\0|\\x00|\\u0000|null\s*byte|nul\s*byte)/i;
const QMD_EMBED_BACKOFF_BASE_MS = 60_000;
const QMD_EMBED_BACKOFF_MAX_MS = 60 * 60 * 1000;
const HAN_SCRIPT_RE = /[\u3400-\u9fff]/u;
const QMD_BM25_HAN_KEYWORD_LIMIT = 12;

let qmdEmbedQueueTail: Promise<void> = Promise.resolve();

function resolveWindowsCommandShim(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return command;
  }
  const ext = path.extname(trimmed).toLowerCase();
  if (ext === ".cmd" || ext === ".exe" || ext === ".bat") {
    return command;
  }
  const base = path.basename(trimmed).toLowerCase();
  if (base === "qmd" || base === "mcporter") {
    return `${trimmed}.cmd`;
  }
  return command;
}

function hasHanScript(value: string): boolean {
  return HAN_SCRIPT_RE.test(value);
}

function normalizeHanBm25Query(query: string): string {
  const trimmed = query.trim();
  if (!trimmed || !hasHanScript(trimmed)) {
    return trimmed;
  }
  const keywords = extractKeywords(trimmed);
  const normalizedKeywords: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const token = keyword.trim();
    if (!token || seen.has(token)) {
      continue;
    }
    const includesHan = hasHanScript(token);
    // Han unigrams are usually too broad for BM25 and can drown signal.
    if (includesHan && Array.from(token).length < 2) {
      continue;
    }
    if (!includesHan && token.length < 2) {
      continue;
    }
    seen.add(token);
    normalizedKeywords.push(token);
    if (normalizedKeywords.length >= QMD_BM25_HAN_KEYWORD_LIMIT) {
      break;
    }
  }
  return normalizedKeywords.length > 0 ? normalizedKeywords.join(" ") : trimmed;
}

async function runWithQmdEmbedLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = qmdEmbedQueueTail;
  let release: (() => void) | undefined;
  qmdEmbedQueueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release?.();
  }
}

type CollectionRoot = {
  path: string;
  kind: MemorySource;
};

type SessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

type ListedCollection = {
  path?: string;
  pattern?: string;
};

type ManagedCollection = {
  name: string;
  path: string;
  pattern: string;
  kind: "memory" | "custom" | "sessions";
};

type QmdManagerMode = "full" | "status";

export class QmdMemoryManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
    mode?: QmdManagerMode;
  }): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const manager = new QmdMemoryManager({ cfg: params.cfg, agentId: params.agentId, resolved });
    await manager.initialize(params.mode ?? "full");
    return manager;
  }

  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;
  private readonly qmd: ResolvedQmdConfig;
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly agentStateDir: string;
  private readonly qmdDir: string;
  private readonly xdgConfigHome: string;
  private readonly xdgCacheHome: string;
  private readonly indexPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly collectionRoots = new Map<string, CollectionRoot>();
  private readonly sources = new Set<MemorySource>();
  private readonly docPathCache = new Map<
    string,
    { rel: string; abs: string; source: MemorySource }
  >();
  private readonly exportedSessionState = new Map<
    string,
    {
      hash: string;
      mtimeMs: number;
      target: string;
    }
  >();
  private readonly maxQmdOutputChars = MAX_QMD_OUTPUT_CHARS;
  private readonly sessionExporter: SessionExporterConfig | null;
  private updateTimer: NodeJS.Timeout | null = null;
  private pendingUpdate: Promise<void> | null = null;
  private queuedForcedUpdate: Promise<void> | null = null;
  private queuedForcedRuns = 0;
  private closed = false;
  private db: SqliteDatabase | null = null;
  private lastUpdateAt: number | null = null;
  private lastEmbedAt: number | null = null;
  private embedBackoffUntil: number | null = null;
  private embedFailureCount = 0;
  private attemptedNullByteCollectionRepair = false;

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedQmdConfig;
  }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.qmd = params.resolved;
    this.workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    this.stateDir = resolveStateDir(process.env, os.homedir);
    this.agentStateDir = path.join(this.stateDir, "agents", this.agentId);
    this.qmdDir = path.join(this.agentStateDir, "qmd");
    // QMD uses XDG base dirs for its internal state.
    // Collections are managed via `qmd collection add` and stored inside the index DB.
    // - config:  $XDG_CONFIG_HOME (contexts, etc.)
    // - cache:   $XDG_CACHE_HOME/qmd/index.sqlite
    this.xdgConfigHome = path.join(this.qmdDir, "xdg-config");
    this.xdgCacheHome = path.join(this.qmdDir, "xdg-cache");
    this.indexPath = path.join(this.xdgCacheHome, "qmd", "index.sqlite");

    this.env = {
      ...process.env,
      XDG_CONFIG_HOME: this.xdgConfigHome,
      XDG_CACHE_HOME: this.xdgCacheHome,
      NO_COLOR: "1",
    };
    this.sessionExporter = this.qmd.sessions.enabled
      ? {
          dir: this.qmd.sessions.exportDir ?? path.join(this.qmdDir, "sessions"),
          retentionMs: this.qmd.sessions.retentionDays
            ? this.qmd.sessions.retentionDays * 24 * 60 * 60 * 1000
            : undefined,
          collectionName: this.pickSessionCollectionName(),
        }
      : null;
    if (this.sessionExporter) {
      this.qmd.collections = [
        ...this.qmd.collections,
        {
          name: this.sessionExporter.collectionName,
          path: this.sessionExporter.dir,
          pattern: "**/*.md",
          kind: "sessions",
        },
      ];
    }
  }

  private async initialize(mode: QmdManagerMode): Promise<void> {
    this.bootstrapCollections();
    if (mode === "status") {
      return;
    }

    await fs.mkdir(this.xdgConfigHome, { recursive: true });
    await fs.mkdir(this.xdgCacheHome, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    if (this.sessionExporter) {
      await fs.mkdir(this.sessionExporter.dir, { recursive: true });
    }

    // QMD stores its ML models under $XDG_CACHE_HOME/qmd/models/.  Because we
    // override XDG_CACHE_HOME to isolate the index per-agent, qmd would not
    // find models installed at the default location (~/.cache/qmd/models/) and
    // would attempt to re-download them on every invocation.  Symlink the
    // default models directory into our custom cache so the index stays
    // isolated while models are shared.
    await this.symlinkSharedModels();

    await this.ensureCollections();

    if (this.qmd.update.onBoot) {
      const bootRun = this.runUpdate("boot", true);
      if (this.qmd.update.waitForBootSync) {
        await bootRun.catch((err) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      } else {
        void bootRun.catch((err) => {
          log.warn(`qmd boot update failed: ${String(err)}`);
        });
      }
    }
    if (this.qmd.update.intervalMs > 0) {
      this.updateTimer = setInterval(() => {
        void this.runUpdate("interval").catch((err) => {
          log.warn(`qmd update failed (${String(err)})`);
        });
      }, this.qmd.update.intervalMs);
    }
  }

  private bootstrapCollections(): void {
    this.collectionRoots.clear();
    this.sources.clear();
    for (const collection of this.qmd.collections) {
      const kind: MemorySource = collection.kind === "sessions" ? "sessions" : "memory";
      this.collectionRoots.set(collection.name, { path: collection.path, kind });
      this.sources.add(kind);
    }
  }

  private async ensureCollections(): Promise<void> {
    // QMD collections are persisted inside the index database and must be created
    // via the CLI. Prefer listing existing collections when supported, otherwise
    // fall back to best-effort idempotent `qmd collection add`.
    const existing = new Map<string, ListedCollection>();
    try {
      const result = await this.runQmd(["collection", "list", "--json"], {
        timeoutMs: this.qmd.update.commandTimeoutMs,
      });
      const parsed = this.parseListedCollections(result.stdout);
      for (const [name, details] of parsed) {
        existing.set(name, details);
      }
    } catch {
      // ignore; older qmd versions might not support list --json.
    }

    await this.migrateLegacyUnscopedCollections(existing);

    for (const collection of this.qmd.collections) {
      const listed = existing.get(collection.name);
      if (listed && !this.shouldRebindCollection(collection, listed)) {
        continue;
      }
      if (listed) {
        try {
          await this.removeCollection(collection.name);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isCollectionMissingError(message)) {
            log.warn(`qmd collection remove failed for ${collection.name}: ${message}`);
          }
        }
      }
      try {
        await this.ensureCollectionPath(collection);
        await this.addCollection(collection.path, collection.name, collection.pattern);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.isCollectionAlreadyExistsError(message)) {
          continue;
        }
        log.warn(`qmd collection add failed for ${collection.name}: ${message}`);
      }
    }
  }

  private async migrateLegacyUnscopedCollections(
    existing: Map<string, ListedCollection>,
  ): Promise<void> {
    for (const collection of this.qmd.collections) {
      if (existing.has(collection.name)) {
        continue;
      }
      const legacyName = this.deriveLegacyCollectionName(collection.name);
      if (!legacyName) {
        continue;
      }
      const listedLegacy = existing.get(legacyName);
      if (!listedLegacy) {
        continue;
      }
      if (!this.canMigrateLegacyCollection(collection, listedLegacy)) {
        log.debug(
          `qmd legacy collection migration skipped for ${legacyName} (path/pattern mismatch)`,
        );
        continue;
      }
      try {
        await this.removeCollection(legacyName);
        existing.delete(legacyName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isCollectionMissingError(message)) {
          log.warn(`qmd collection remove failed for ${legacyName}: ${message}`);
        }
      }
    }
  }

  private deriveLegacyCollectionName(scopedName: string): string | null {
    const agentSuffix = `-${this.sanitizeCollectionNameSegment(this.agentId)}`;
    if (!scopedName.endsWith(agentSuffix)) {
      return null;
    }
    const legacyName = scopedName.slice(0, -agentSuffix.length).trim();
    return legacyName || null;
  }

  private canMigrateLegacyCollection(
    collection: ManagedCollection,
    listedLegacy: ListedCollection,
  ): boolean {
    if (listedLegacy.path && !this.pathsMatch(listedLegacy.path, collection.path)) {
      return false;
    }
    if (typeof listedLegacy.pattern === "string" && listedLegacy.pattern !== collection.pattern) {
      return false;
    }
    return true;
  }

  private async ensureCollectionPath(collection: {
    path: string;
    pattern: string;
    kind: "memory" | "custom" | "sessions";
  }): Promise<void> {
    if (!this.isDirectoryGlobPattern(collection.pattern)) {
      return;
    }
    await fs.mkdir(collection.path, { recursive: true });
  }

  private isDirectoryGlobPattern(pattern: string): boolean {
    return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
  }

  private isCollectionAlreadyExistsError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("already exists") || lower.includes("exists");
  }

  private isCollectionMissingError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("not found") || lower.includes("does not exist") || lower.includes("missing")
    );
  }

  private isMissingCollectionSearchError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return this.isCollectionMissingError(message) && message.toLowerCase().includes("collection");
  }

  private async tryRepairMissingCollectionSearch(err: unknown): Promise<boolean> {
    if (!this.isMissingCollectionSearchError(err)) {
      return false;
    }
    log.warn(
      "qmd search failed because a managed collection is missing; repairing collections and retrying once",
    );
    await this.ensureCollections();
    return true;
  }

  private async addCollection(pathArg: string, name: string, pattern: string): Promise<void> {
    await this.runQmd(["collection", "add", pathArg, "--name", name, "--mask", pattern], {
      timeoutMs: this.qmd.update.commandTimeoutMs,
    });
  }

  private async removeCollection(name: string): Promise<void> {
    await this.runQmd(["collection", "remove", name], {
      timeoutMs: this.qmd.update.commandTimeoutMs,
    });
  }

  private parseListedCollections(output: string): Map<string, ListedCollection> {
    const listed = new Map<string, ListedCollection>();
    const trimmed = output.trim();
    if (!trimmed) {
      return listed;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string") {
            listed.set(entry, {});
            continue;
          }
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const name = (entry as { name?: unknown }).name;
          if (typeof name !== "string") {
            continue;
          }
          const listedPath = (entry as { path?: unknown }).path;
          const listedPattern = (entry as { pattern?: unknown; mask?: unknown }).pattern;
          const listedMask = (entry as { mask?: unknown }).mask;
          listed.set(name, {
            path: typeof listedPath === "string" ? listedPath : undefined,
            pattern:
              typeof listedPattern === "string"
                ? listedPattern
                : typeof listedMask === "string"
                  ? listedMask
                  : undefined,
          });
        }
        return listed;
      }
    } catch {
      // Some qmd builds ignore `--json` and still print table output.
    }

    let currentName: string | null = null;
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        currentName = null;
        continue;
      }
      const collectionLine = /^\s*([a-z0-9._-]+)\s+\(qmd:\/\/[^)]+\)\s*$/i.exec(line);
      if (collectionLine) {
        currentName = collectionLine[1];
        if (!listed.has(currentName)) {
          listed.set(currentName, {});
        }
        continue;
      }
      if (/^\s*collections\b/i.test(line)) {
        continue;
      }
      const bareNameLine = /^\s*([a-z0-9._-]+)\s*$/i.exec(line);
      if (bareNameLine && !line.includes(":")) {
        currentName = bareNameLine[1];
        if (!listed.has(currentName)) {
          listed.set(currentName, {});
        }
        continue;
      }
      if (!currentName) {
        continue;
      }
      const patternLine = /^\s*(?:pattern|mask)\s*:\s*(.+?)\s*$/i.exec(line);
      if (patternLine) {
        const existing = listed.get(currentName) ?? {};
        existing.pattern = patternLine[1].trim();
        listed.set(currentName, existing);
        continue;
      }
      const pathLine = /^\s*path\s*:\s*(.+?)\s*$/i.exec(line);
      if (pathLine) {
        const existing = listed.get(currentName) ?? {};
        existing.path = pathLine[1].trim();
        listed.set(currentName, existing);
      }
    }
    return listed;
  }

  private shouldRebindCollection(collection: ManagedCollection, listed: ListedCollection): boolean {
    if (!listed.path) {
      // Older qmd versions may only return names from `collection list --json`.
      // Rebind managed collections so stale path bindings cannot survive upgrades.
      return true;
    }
    if (!this.pathsMatch(listed.path, collection.path)) {
      return true;
    }
    if (typeof listed.pattern === "string" && listed.pattern !== collection.pattern) {
      return true;
    }
    return false;
  }

  private pathsMatch(left: string, right: string): boolean {
    const normalize = (value: string): string => {
      const resolved = path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(this.workspaceDir, value);
      const normalized = path.normalize(resolved);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return normalize(left) === normalize(right);
  }

  private shouldRepairNullByteCollectionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    return (
      (lower.includes("enotdir") || lower.includes("not a directory")) &&
      NUL_MARKER_RE.test(message)
    );
  }

  private async tryRepairNullByteCollections(err: unknown, reason: string): Promise<boolean> {
    if (this.attemptedNullByteCollectionRepair) {
      return false;
    }
    if (!this.shouldRepairNullByteCollectionError(err)) {
      return false;
    }
    this.attemptedNullByteCollectionRepair = true;
    log.warn(
      `qmd update failed with suspected null-byte collection metadata (${reason}); rebuilding managed collections and retrying once`,
    );
    for (const collection of this.qmd.collections) {
      try {
        await this.removeCollection(collection.name);
      } catch (removeErr) {
        const removeMessage = removeErr instanceof Error ? removeErr.message : String(removeErr);
        if (!this.isCollectionMissingError(removeMessage)) {
          log.warn(`qmd collection remove failed for ${collection.name}: ${removeMessage}`);
        }
      }
      try {
        await this.addCollection(collection.path, collection.name, collection.pattern);
      } catch (addErr) {
        const addMessage = addErr instanceof Error ? addErr.message : String(addErr);
        if (!this.isCollectionAlreadyExistsError(addMessage)) {
          log.warn(`qmd collection add failed for ${collection.name}: ${addMessage}`);
        }
      }
    }
    return true;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    if (!this.isScopeAllowed(opts?.sessionKey)) {
      this.logScopeDenied(opts?.sessionKey);
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.waitForPendingUpdateBeforeSearch();
    const limit = Math.min(
      this.qmd.limits.maxResults,
      opts?.maxResults ?? this.qmd.limits.maxResults,
    );
    const collectionNames = this.listManagedCollectionNames();
    if (collectionNames.length === 0) {
      log.warn("qmd query skipped: no managed collections configured");
      return [];
    }
    const qmdSearchCommand = this.qmd.searchMode;
    const mcporterEnabled = this.qmd.mcporter.enabled;
    const runSearchAttempt = async (
      allowMissingCollectionRepair: boolean,
    ): Promise<QmdQueryResult[]> => {
      try {
        if (mcporterEnabled) {
          const tool: "search" | "vector_search" | "deep_search" =
            qmdSearchCommand === "search"
              ? "search"
              : qmdSearchCommand === "vsearch"
                ? "vector_search"
                : "deep_search";
          const minScore = opts?.minScore ?? 0;
          if (collectionNames.length > 1) {
            return await this.runMcporterAcrossCollections({
              tool,
              query: trimmed,
              limit,
              minScore,
              collectionNames,
            });
          }
          return await this.runQmdSearchViaMcporter({
            mcporter: this.qmd.mcporter,
            tool,
            query: trimmed,
            limit,
            minScore,
            collection: collectionNames[0],
            timeoutMs: this.qmd.limits.timeoutMs,
          });
        }
        if (collectionNames.length > 1) {
          return await this.runQueryAcrossCollections(
            trimmed,
            limit,
            collectionNames,
            qmdSearchCommand,
          );
        }
        const args = this.buildSearchArgs(qmdSearchCommand, trimmed, limit);
        args.push(...this.buildCollectionFilterArgs(collectionNames));
        // Always scope to managed collections (default + custom). Even for `search`/`vsearch`,
        // pass collection filters; if a given QMD build rejects these flags, we fall back to `query`.
        const result = await this.runQmd(args, { timeoutMs: this.qmd.limits.timeoutMs });
        return parseQmdQueryJson(result.stdout, result.stderr);
      } catch (err) {
        if (allowMissingCollectionRepair && this.isMissingCollectionSearchError(err)) {
          throw err;
        }
        if (
          !mcporterEnabled &&
          qmdSearchCommand !== "query" &&
          this.isUnsupportedQmdOptionError(err)
        ) {
          log.warn(
            `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
          );
          try {
            if (collectionNames.length > 1) {
              return await this.runQueryAcrossCollections(trimmed, limit, collectionNames, "query");
            }
            const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
            fallbackArgs.push(...this.buildCollectionFilterArgs(collectionNames));
            const fallback = await this.runQmd(fallbackArgs, {
              timeoutMs: this.qmd.limits.timeoutMs,
            });
            return parseQmdQueryJson(fallback.stdout, fallback.stderr);
          } catch (fallbackErr) {
            log.warn(`qmd query fallback failed: ${String(fallbackErr)}`);
            throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
          }
        }
        const label = mcporterEnabled ? "mcporter/qmd" : `qmd ${qmdSearchCommand}`;
        log.warn(`${label} failed: ${String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    let parsed: QmdQueryResult[];
    try {
      parsed = await runSearchAttempt(true);
    } catch (err) {
      if (!(await this.tryRepairMissingCollectionSearch(err))) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      parsed = await runSearchAttempt(false);
    }
    const results: MemorySearchResult[] = [];
    for (const entry of parsed) {
      const doc = await this.resolveDocLocation(entry.docid, {
        preferredCollection: entry.collection,
        preferredFile: entry.file,
      });
      if (!doc) {
        continue;
      }
      const snippet = entry.snippet?.slice(0, this.qmd.limits.maxSnippetChars) ?? "";
      const lines = this.extractSnippetLines(snippet);
      const score = typeof entry.score === "number" ? entry.score : 0;
      const minScore = opts?.minScore ?? 0;
      if (score < minScore) {
        continue;
      }
      results.push({
        path: doc.rel,
        startLine: lines.startLine,
        endLine: lines.endLine,
        score,
        snippet,
        source: doc.source,
      });
    }
    return this.clampResultsByInjectedChars(this.diversifyResultsBySource(results, limit));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (params?.progress) {
      params.progress({ completed: 0, total: 1, label: "Updating QMD index…" });
    }
    await this.runUpdate(params?.reason ?? "manual", params?.force);
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "QMD index updated" });
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const relPath = params.relPath?.trim();
    if (!relPath) {
      throw new Error("path required");
    }
    const absPath = this.resolveReadPath(relPath);
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const statResult = await statRegularFile(absPath);
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    if (params.from !== undefined || params.lines !== undefined) {
      const partial = await this.readPartialText(absPath, params.from, params.lines);
      if (partial.missing) {
        return { text: "", path: relPath };
      }
      return { text: partial.text, path: relPath };
    }
    const full = await this.readFullText(absPath);
    if (full.missing) {
      return { text: "", path: relPath };
    }
    if (!params.from && !params.lines) {
      return { text: full.text, path: relPath };
    }
    const lines = full.text.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const counts = this.readCounts();
    return {
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      files: counts.totalDocuments,
      chunks: counts.totalDocuments,
      dirty: false,
      workspaceDir: this.workspaceDir,
      dbPath: this.indexPath,
      sources: Array.from(this.sources),
      sourceCounts: counts.sourceCounts,
      vector: { enabled: true, available: true },
      batch: {
        enabled: false,
        failures: 0,
        limit: 0,
        wait: false,
        concurrency: 0,
        pollIntervalMs: 0,
        timeoutMs: 0,
      },
      custom: {
        qmd: {
          collections: this.qmd.collections.length,
          lastUpdateAt: this.lastUpdateAt,
        },
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.queuedForcedRuns = 0;
    await this.pendingUpdate?.catch(() => undefined);
    await this.queuedForcedUpdate?.catch(() => undefined);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private async runUpdate(
    reason: string,
    force?: boolean,
    opts?: { fromForcedQueue?: boolean },
  ): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.pendingUpdate) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.pendingUpdate;
    }
    if (this.queuedForcedUpdate && !opts?.fromForcedQueue) {
      if (force) {
        return this.enqueueForcedUpdate(reason);
      }
      return this.queuedForcedUpdate;
    }
    if (this.shouldSkipUpdate(force)) {
      return;
    }
    const run = async () => {
      if (this.sessionExporter) {
        await this.exportSessions();
      }
      await this.runQmdUpdateWithRetry(reason);
      if (this.shouldRunEmbed(force)) {
        try {
          await runWithQmdEmbedLock(async () => {
            await this.runQmd(["embed"], { timeoutMs: this.qmd.update.embedTimeoutMs });
          });
          this.lastEmbedAt = Date.now();
          this.embedBackoffUntil = null;
          this.embedFailureCount = 0;
        } catch (err) {
          this.noteEmbedFailure(reason, err);
        }
      }
      this.lastUpdateAt = Date.now();
      this.docPathCache.clear();
    };
    this.pendingUpdate = run().finally(() => {
      this.pendingUpdate = null;
    });
    await this.pendingUpdate;
  }

  private async runQmdUpdateWithRetry(reason: string): Promise<void> {
    const isBootRun = reason === "boot" || reason.startsWith("boot:");
    const maxAttempts = isBootRun ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.runQmdUpdateOnce(reason);
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !this.isRetryableUpdateError(err)) {
          throw err;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        log.warn(
          `qmd update retry ${attempt}/${maxAttempts - 1} after failure (${reason}): ${String(err)}`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async runQmdUpdateOnce(reason: string): Promise<void> {
    try {
      await this.runQmd(["update"], { timeoutMs: this.qmd.update.updateTimeoutMs });
    } catch (err) {
      if (!(await this.tryRepairNullByteCollections(err, reason))) {
        throw err;
      }
      await this.runQmd(["update"], { timeoutMs: this.qmd.update.updateTimeoutMs });
    }
  }

  private isRetryableUpdateError(err: unknown): boolean {
    if (this.isSqliteBusyError(err)) {
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    return normalized.includes("timed out");
  }

  private shouldRunEmbed(force?: boolean): boolean {
    if (this.qmd.searchMode === "search") {
      return false;
    }
    const now = Date.now();
    if (this.embedBackoffUntil !== null && now < this.embedBackoffUntil) {
      return false;
    }
    const embedIntervalMs = this.qmd.update.embedIntervalMs;
    return (
      Boolean(force) ||
      this.lastEmbedAt === null ||
      (embedIntervalMs > 0 && now - this.lastEmbedAt > embedIntervalMs)
    );
  }

  private noteEmbedFailure(reason: string, err: unknown): void {
    this.embedFailureCount += 1;
    const delayMs = Math.min(
      QMD_EMBED_BACKOFF_MAX_MS,
      QMD_EMBED_BACKOFF_BASE_MS * 2 ** Math.max(0, this.embedFailureCount - 1),
    );
    this.embedBackoffUntil = Date.now() + delayMs;
    log.warn(
      `qmd embed failed (${reason}): ${String(err)}; backing off for ${Math.ceil(delayMs / 1000)}s`,
    );
  }

  private enqueueForcedUpdate(reason: string): Promise<void> {
    this.queuedForcedRuns += 1;
    if (!this.queuedForcedUpdate) {
      this.queuedForcedUpdate = this.drainForcedUpdates(reason).finally(() => {
        this.queuedForcedUpdate = null;
      });
    }
    return this.queuedForcedUpdate;
  }

  private async drainForcedUpdates(reason: string): Promise<void> {
    await this.pendingUpdate?.catch(() => undefined);
    while (!this.closed && this.queuedForcedRuns > 0) {
      this.queuedForcedRuns -= 1;
      await this.runUpdate(`${reason}:queued`, true, { fromForcedQueue: true });
    }
  }

  /**
   * Symlink the default QMD models directory into our custom XDG_CACHE_HOME so
   * that the pre-installed ML models (~/.cache/qmd/models/) are reused rather
   * than re-downloaded for every agent.  If the default models directory does
   * not exist, or a models directory/symlink already exists in the target, this
   * is a no-op.
   */
  private async symlinkSharedModels(): Promise<void> {
    // process.env is never modified — only this.env (passed to child_process
    // spawn) overrides XDG_CACHE_HOME.  So reading it here gives us the
    // user's original value, which is where `qmd` downloaded its models.
    //
    // On Windows, well-behaved apps (including Rust `dirs` / Go os.UserCacheDir)
    // store caches under %LOCALAPPDATA% rather than ~/.cache.  Fall back to
    // LOCALAPPDATA when XDG_CACHE_HOME is not set on Windows.
    const defaultCacheHome =
      process.env.XDG_CACHE_HOME ||
      (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
      path.join(os.homedir(), ".cache");
    const defaultModelsDir = path.join(defaultCacheHome, "qmd", "models");
    const targetModelsDir = path.join(this.xdgCacheHome, "qmd", "models");
    try {
      // Check if the default models directory exists.
      // Missing path is normal on first run and should be silent.
      const stat = await fs.stat(defaultModelsDir).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      });
      if (!stat?.isDirectory()) {
        return;
      }
      // Check if something already exists at the target path
      try {
        await fs.lstat(targetModelsDir);
        // Already exists (directory, symlink, or file) – leave it alone
        return;
      } catch {
        // Does not exist – proceed to create symlink
      }
      // On Windows, creating directory symlinks requires either Administrator
      // privileges or Developer Mode.  Fall back to a directory junction which
      // works without elevated privileges (junctions are always absolute-path,
      // which is fine here since both paths are already absolute).
      try {
        await fs.symlink(defaultModelsDir, targetModelsDir, "dir");
      } catch (symlinkErr: unknown) {
        const code = (symlinkErr as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "ENOTSUP")) {
          await fs.symlink(defaultModelsDir, targetModelsDir, "junction");
        } else {
          throw symlinkErr;
        }
      }
      log.debug(`symlinked qmd models: ${defaultModelsDir} → ${targetModelsDir}`);
    } catch (err) {
      // Non-fatal: if we can't symlink, qmd will fall back to downloading
      log.warn(`failed to symlink qmd models directory: ${String(err)}`);
    }
  }

  private async runQmd(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(resolveWindowsCommandShim(this.qmd.command), args, {
        env: this.env,
        cwd: this.workspaceDir,
      });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`qmd ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;
      child.stdout.on("data", (data) => {
        const next = appendOutputWithCap(stdout, data.toString("utf8"), this.maxQmdOutputChars);
        stdout = next.text;
        stdoutTruncated = stdoutTruncated || next.truncated;
      });
      child.stderr.on("data", (data) => {
        const next = appendOutputWithCap(stderr, data.toString("utf8"), this.maxQmdOutputChars);
        stderr = next.text;
        stderrTruncated = stderrTruncated || next.truncated;
      });
      child.on("error", (err) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        if (stdoutTruncated || stderrTruncated) {
          reject(
            new Error(
              `qmd ${args.join(" ")} produced too much output (limit ${this.maxQmdOutputChars} chars)`,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`qmd ${args.join(" ")} failed (code ${code}): ${stderr || stdout}`));
        }
      });
    });
  }

  private async ensureMcporterDaemonStarted(mcporter: ResolvedQmdMcporterConfig): Promise<void> {
    if (!mcporter.enabled) {
      return;
    }
    if (!mcporter.startDaemon) {
      type McporterWarnGlobal = typeof globalThis & {
        __openclawMcporterColdStartWarned?: boolean;
      };
      const g: McporterWarnGlobal = globalThis;
      if (!g.__openclawMcporterColdStartWarned) {
        g.__openclawMcporterColdStartWarned = true;
        log.warn(
          "mcporter qmd bridge enabled but startDaemon=false; each query may cold-start QMD MCP. Consider setting memory.qmd.mcporter.startDaemon=true to keep it warm.",
        );
      }
      return;
    }
    type McporterGlobal = typeof globalThis & {
      __openclawMcporterDaemonStart?: Promise<void>;
    };
    const g: McporterGlobal = globalThis;
    if (!g.__openclawMcporterDaemonStart) {
      g.__openclawMcporterDaemonStart = (async () => {
        try {
          await this.runMcporter(["daemon", "start"], { timeoutMs: 10_000 });
        } catch (err) {
          log.warn(`mcporter daemon start failed: ${String(err)}`);
          // Allow future searches to retry daemon start on transient failures.
          delete g.__openclawMcporterDaemonStart;
        }
      })();
    }
    await g.__openclawMcporterDaemonStart;
  }

  private async runMcporter(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(resolveWindowsCommandShim("mcporter"), args, {
        // Keep mcporter and direct qmd commands on the same agent-scoped XDG state.
        env: this.env,
        cwd: this.workspaceDir,
      });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`mcporter ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;
      child.stdout.on("data", (data) => {
        const next = appendOutputWithCap(stdout, data.toString("utf8"), this.maxQmdOutputChars);
        stdout = next.text;
        stdoutTruncated = stdoutTruncated || next.truncated;
      });
      child.stderr.on("data", (data) => {
        const next = appendOutputWithCap(stderr, data.toString("utf8"), this.maxQmdOutputChars);
        stderr = next.text;
        stderrTruncated = stderrTruncated || next.truncated;
      });
      child.on("error", (err) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) {
          clearTimeout(timer);
        }
        if (stdoutTruncated || stderrTruncated) {
          reject(
            new Error(
              `mcporter ${args.join(" ")} produced too much output (limit ${this.maxQmdOutputChars} chars)`,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(`mcporter ${args.join(" ")} failed (code ${code}): ${stderr || stdout}`),
          );
        }
      });
    });
  }

  private async runQmdSearchViaMcporter(params: {
    mcporter: ResolvedQmdMcporterConfig;
    tool: "search" | "vector_search" | "deep_search";
    query: string;
    limit: number;
    minScore: number;
    collection?: string;
    timeoutMs: number;
  }): Promise<QmdQueryResult[]> {
    await this.ensureMcporterDaemonStarted(params.mcporter);

    const selector = `${params.mcporter.serverName}.${params.tool}`;
    const callArgs: Record<string, unknown> = {
      query: params.query,
      limit: params.limit,
      minScore: params.minScore,
    };
    if (params.collection) {
      callArgs.collection = params.collection;
    }

    const result = await this.runMcporter(
      [
        "call",
        selector,
        "--args",
        JSON.stringify(callArgs),
        "--output",
        "json",
        "--timeout",
        String(Math.max(0, params.timeoutMs)),
      ],
      { timeoutMs: Math.max(params.timeoutMs + 2_000, 5_000) },
    );

    const parsedUnknown: unknown = JSON.parse(result.stdout);
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    const structured =
      isRecord(parsedUnknown) && isRecord(parsedUnknown.structuredContent)
        ? parsedUnknown.structuredContent
        : parsedUnknown;

    const results: unknown[] =
      isRecord(structured) && Array.isArray(structured.results)
        ? (structured.results as unknown[])
        : Array.isArray(structured)
          ? structured
          : [];

    const out: QmdQueryResult[] = [];
    for (const item of results) {
      if (!isRecord(item)) {
        continue;
      }
      const docidRaw = item.docid;
      const docid = typeof docidRaw === "string" ? docidRaw.replace(/^#/, "").trim() : "";
      if (!docid) {
        continue;
      }
      const scoreRaw = item.score;
      const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
      const snippet = typeof item.snippet === "string" ? item.snippet : "";
      out.push({ docid, score: Number.isFinite(score) ? score : 0, snippet });
    }
    return out;
  }

  private async readPartialText(
    absPath: string,
    from?: number,
    lines?: number,
  ): Promise<{ missing: true } | { missing: false; text: string }> {
    const start = Math.max(1, from ?? 1);
    const count = Math.max(1, lines ?? Number.POSITIVE_INFINITY);
    let handle;
    try {
      handle = await fs.open(absPath);
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
    const stream = handle.createReadStream({ encoding: "utf-8" });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    const selected: string[] = [];
    let index = 0;
    try {
      for await (const line of rl) {
        index += 1;
        if (index < start) {
          continue;
        }
        if (selected.length >= count) {
          break;
        }
        selected.push(line);
      }
    } finally {
      rl.close();
      await handle.close();
    }
    return { missing: false, text: selected.slice(0, count).join("\n") };
  }

  private async readFullText(
    absPath: string,
  ): Promise<{ missing: true } | { missing: false; text: string }> {
    try {
      const text = await fs.readFile(absPath, "utf-8");
      return { missing: false, text };
    } catch (err) {
      if (isFileMissingError(err)) {
        return { missing: true };
      }
      throw err;
    }
  }

  private ensureDb(): SqliteDatabase {
    if (this.db) {
      return this.db;
    }
    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(this.indexPath, { readOnly: true });
    // Keep QMD recall responsive when the updater holds a write lock.
    this.db.exec("PRAGMA busy_timeout = 1");
    return this.db;
  }

  private async exportSessions(): Promise<void> {
    if (!this.sessionExporter) {
      return;
    }
    const exportDir = this.sessionExporter.dir;
    await fs.mkdir(exportDir, { recursive: true });
    const files = await listSessionFilesForAgent(this.agentId);
    const keep = new Set<string>();
    const tracked = new Set<string>();
    const cutoff = this.sessionExporter.retentionMs
      ? Date.now() - this.sessionExporter.retentionMs
      : null;
    for (const sessionFile of files) {
      const entry = await buildSessionEntry(sessionFile);
      if (!entry) {
        continue;
      }
      if (cutoff && entry.mtimeMs < cutoff) {
        continue;
      }
      const target = path.join(exportDir, `${path.basename(sessionFile, ".jsonl")}.md`);
      tracked.add(sessionFile);
      const state = this.exportedSessionState.get(sessionFile);
      if (!state || state.hash !== entry.hash || state.mtimeMs !== entry.mtimeMs) {
        await fs.writeFile(target, this.renderSessionMarkdown(entry), "utf-8");
      }
      this.exportedSessionState.set(sessionFile, {
        hash: entry.hash,
        mtimeMs: entry.mtimeMs,
        target,
      });
      keep.add(target);
    }
    const exported = await fs.readdir(exportDir).catch(() => []);
    for (const name of exported) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const full = path.join(exportDir, name);
      if (!keep.has(full)) {
        await fs.rm(full, { force: true });
      }
    }
    for (const [sessionFile, state] of this.exportedSessionState) {
      if (!tracked.has(sessionFile) || !state.target.startsWith(exportDir + path.sep)) {
        this.exportedSessionState.delete(sessionFile);
      }
    }
  }

  private renderSessionMarkdown(entry: SessionFileEntry): string {
    const header = `# Session ${path.basename(entry.absPath, path.extname(entry.absPath))}`;
    const body = entry.content?.trim().length ? entry.content.trim() : "(empty)";
    return `${header}\n\n${body}\n`;
  }

  private pickSessionCollectionName(): string {
    const existing = new Set(this.qmd.collections.map((collection) => collection.name));
    const base = `sessions-${this.sanitizeCollectionNameSegment(this.agentId)}`;
    if (!existing.has(base)) {
      return base;
    }
    let counter = 2;
    let candidate = `${base}-${counter}`;
    while (existing.has(candidate)) {
      counter += 1;
      candidate = `${base}-${counter}`;
    }
    return candidate;
  }

  private sanitizeCollectionNameSegment(input: string): string {
    const lower = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const trimmed = lower.replace(/^-+|-+$/g, "");
    return trimmed || "agent";
  }

  private async resolveDocLocation(
    docid?: string,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): Promise<{ rel: string; abs: string; source: MemorySource } | null> {
    if (!docid) {
      return null;
    }
    const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
    if (!normalized) {
      return null;
    }
    const cacheKey = `${hints?.preferredCollection ?? "*"}:${normalized}`;
    const cached = this.docPathCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const db = this.ensureDb();
    let rows: Array<{ collection: string; path: string }> = [];
    try {
      rows = db
        .prepare("SELECT collection, path FROM documents WHERE hash = ? AND active = 1")
        .all(normalized) as Array<{ collection: string; path: string }>;
      if (rows.length === 0) {
        rows = db
          .prepare("SELECT collection, path FROM documents WHERE hash LIKE ? AND active = 1")
          .all(`${normalized}%`) as Array<{ collection: string; path: string }>;
      }
    } catch (err) {
      if (this.isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving doc path: ${String(err)}`);
        throw this.createQmdBusyError(err);
      }
      throw err;
    }
    if (rows.length === 0) {
      return null;
    }
    const location = this.pickDocLocation(rows, hints);
    if (!location) {
      return null;
    }
    this.docPathCache.set(cacheKey, location);
    return location;
  }

  private pickDocLocation(
    rows: Array<{ collection: string; path: string }>,
    hints?: { preferredCollection?: string; preferredFile?: string },
  ): { rel: string; abs: string; source: MemorySource } | null {
    if (hints?.preferredCollection) {
      for (const row of rows) {
        if (row.collection !== hints.preferredCollection) {
          continue;
        }
        const location = this.toDocLocation(row.collection, row.path);
        if (location) {
          return location;
        }
      }
    }
    if (hints?.preferredFile) {
      const preferred = path.normalize(hints.preferredFile);
      for (const row of rows) {
        const rowPath = path.normalize(row.path);
        if (rowPath !== preferred && !rowPath.endsWith(path.sep + preferred)) {
          continue;
        }
        const location = this.toDocLocation(row.collection, row.path);
        if (location) {
          return location;
        }
      }
    }
    for (const row of rows) {
      const location = this.toDocLocation(row.collection, row.path);
      if (location) {
        return location;
      }
    }
    return null;
  }

  private extractSnippetLines(snippet: string): { startLine: number; endLine: number } {
    const match = SNIPPET_HEADER_RE.exec(snippet);
    if (match) {
      const start = Number(match[1]);
      const count = Number(match[2]);
      if (Number.isFinite(start) && Number.isFinite(count)) {
        return { startLine: start, endLine: start + count - 1 };
      }
    }
    const lines = snippet.split("\n").length;
    return { startLine: 1, endLine: lines };
  }

  private readCounts(): {
    totalDocuments: number;
    sourceCounts: Array<{ source: MemorySource; files: number; chunks: number }>;
  } {
    try {
      const db = this.ensureDb();
      const rows = db
        .prepare(
          "SELECT collection, COUNT(*) as c FROM documents WHERE active = 1 GROUP BY collection",
        )
        .all() as Array<{ collection: string; c: number }>;
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of this.sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      let total = 0;
      for (const row of rows) {
        const root = this.collectionRoots.get(row.collection);
        const source = root?.kind ?? "memory";
        const entry = bySource.get(source) ?? { files: 0, chunks: 0 };
        entry.files += row.c ?? 0;
        entry.chunks += row.c ?? 0;
        bySource.set(source, entry);
        total += row.c ?? 0;
      }
      return {
        totalDocuments: total,
        sourceCounts: Array.from(bySource.entries()).map(([source, value]) => ({
          source,
          files: value.files,
          chunks: value.chunks,
        })),
      };
    } catch (err) {
      log.warn(`failed to read qmd index stats: ${String(err)}`);
      return {
        totalDocuments: 0,
        sourceCounts: Array.from(this.sources).map((source) => ({ source, files: 0, chunks: 0 })),
      };
    }
  }

  private logScopeDenied(sessionKey?: string): void {
    const channel = deriveQmdScopeChannel(sessionKey) ?? "unknown";
    const chatType = deriveQmdScopeChatType(sessionKey) ?? "unknown";
    const key = sessionKey?.trim() || "<none>";
    log.warn(
      `qmd search denied by scope (channel=${channel}, chatType=${chatType}, session=${key})`,
    );
  }

  private isScopeAllowed(sessionKey?: string): boolean {
    return isQmdScopeAllowed(this.qmd.scope, sessionKey);
  }

  private toDocLocation(
    collection: string,
    collectionRelativePath: string,
  ): { rel: string; abs: string; source: MemorySource } | null {
    const root = this.collectionRoots.get(collection);
    if (!root) {
      return null;
    }
    const normalizedRelative = collectionRelativePath.replace(/\\/g, "/");
    const absPath = path.normalize(path.resolve(root.path, collectionRelativePath));
    const relativeToWorkspace = path.relative(this.workspaceDir, absPath);
    const relPath = this.buildSearchPath(
      collection,
      normalizedRelative,
      relativeToWorkspace,
      absPath,
    );
    return { rel: relPath, abs: absPath, source: root.kind };
  }

  private buildSearchPath(
    collection: string,
    collectionRelativePath: string,
    relativeToWorkspace: string,
    absPath: string,
  ): string {
    const insideWorkspace = this.isInsideWorkspace(relativeToWorkspace);
    if (insideWorkspace) {
      const normalized = relativeToWorkspace.replace(/\\/g, "/");
      if (!normalized) {
        return path.basename(absPath);
      }
      return normalized;
    }
    const sanitized = collectionRelativePath.replace(/^\/+/, "");
    return `qmd/${collection}/${sanitized}`;
  }

  private isInsideWorkspace(relativePath: string): boolean {
    if (!relativePath) {
      return true;
    }
    if (relativePath.startsWith("..")) {
      return false;
    }
    if (relativePath.startsWith(`..${path.sep}`)) {
      return false;
    }
    return !path.isAbsolute(relativePath);
  }

  private resolveReadPath(relPath: string): string {
    if (relPath.startsWith("qmd/")) {
      const [, collection, ...rest] = relPath.split("/");
      if (!collection || rest.length === 0) {
        throw new Error("invalid qmd path");
      }
      const root = this.collectionRoots.get(collection);
      if (!root) {
        throw new Error(`unknown qmd collection: ${collection}`);
      }
      const joined = rest.join("/");
      const resolved = path.resolve(root.path, joined);
      if (!this.isWithinRoot(root.path, resolved)) {
        throw new Error("qmd path escapes collection");
      }
      return resolved;
    }
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!this.isWithinWorkspace(absPath)) {
      throw new Error("path escapes workspace");
    }
    return absPath;
  }

  private isWithinWorkspace(absPath: string): boolean {
    const normalizedWorkspace = this.workspaceDir.endsWith(path.sep)
      ? this.workspaceDir
      : `${this.workspaceDir}${path.sep}`;
    if (absPath === this.workspaceDir) {
      return true;
    }
    const candidate = absPath.endsWith(path.sep) ? absPath : `${absPath}${path.sep}`;
    return candidate.startsWith(normalizedWorkspace);
  }

  private isWithinRoot(root: string, candidate: string): boolean {
    const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (candidate === root) {
      return true;
    }
    const next = candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`;
    return next.startsWith(normalizedRoot);
  }

  private clampResultsByInjectedChars(results: MemorySearchResult[]): MemorySearchResult[] {
    const budget = this.qmd.limits.maxInjectedChars;
    if (!budget || budget <= 0) {
      return results;
    }
    let remaining = budget;
    const clamped: MemorySearchResult[] = [];
    for (const entry of results) {
      if (remaining <= 0) {
        break;
      }
      const snippet = entry.snippet ?? "";
      if (snippet.length <= remaining) {
        clamped.push(entry);
        remaining -= snippet.length;
      } else {
        const trimmed = snippet.slice(0, Math.max(0, remaining));
        clamped.push({ ...entry, snippet: trimmed });
        break;
      }
    }
    return clamped;
  }

  private diversifyResultsBySource(
    results: MemorySearchResult[],
    limit: number,
  ): MemorySearchResult[] {
    const target = Math.max(0, limit);
    if (target <= 0) {
      return [];
    }
    if (results.length <= 1) {
      return results.slice(0, target);
    }
    const bySource = new Map<MemorySource, MemorySearchResult[]>();
    for (const entry of results) {
      const list = bySource.get(entry.source) ?? [];
      list.push(entry);
      bySource.set(entry.source, list);
    }
    const hasSessions = bySource.has("sessions");
    const hasMemory = bySource.has("memory");
    if (!hasSessions || !hasMemory) {
      return results.slice(0, target);
    }
    const sourceOrder = Array.from(bySource.entries())
      .toSorted((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0))
      .map(([source]) => source);
    const diversified: MemorySearchResult[] = [];
    while (diversified.length < target) {
      let emitted = false;
      for (const source of sourceOrder) {
        const next = bySource.get(source)?.shift();
        if (!next) {
          continue;
        }
        diversified.push(next);
        emitted = true;
        if (diversified.length >= target) {
          break;
        }
      }
      if (!emitted) {
        break;
      }
    }
    return diversified;
  }

  private shouldSkipUpdate(force?: boolean): boolean {
    if (force) {
      return false;
    }
    const debounceMs = this.qmd.update.debounceMs;
    if (debounceMs <= 0) {
      return false;
    }
    if (!this.lastUpdateAt) {
      return false;
    }
    return Date.now() - this.lastUpdateAt < debounceMs;
  }

  private isSqliteBusyError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    return normalized.includes("sqlite_busy") || normalized.includes("database is locked");
  }

  private isUnsupportedQmdOptionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("unknown flag") ||
      normalized.includes("unknown option") ||
      normalized.includes("unrecognized option") ||
      normalized.includes("flag provided but not defined") ||
      normalized.includes("unexpected argument")
    );
  }

  private createQmdBusyError(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    return new Error(`qmd index busy while reading results: ${message}`);
  }

  private async waitForPendingUpdateBeforeSearch(): Promise<void> {
    const pending = this.pendingUpdate;
    if (!pending) {
      return;
    }
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, SEARCH_PENDING_UPDATE_WAIT_MS)),
    ]);
  }

  private async runQueryAcrossCollections(
    query: string,
    limit: number,
    collectionNames: string[],
    command: "query" | "search" | "vsearch",
  ): Promise<QmdQueryResult[]> {
    log.debug(
      `qmd ${command} multi-collection workaround active (${collectionNames.length} collections)`,
    );
    const bestByDocId = new Map<string, QmdQueryResult>();
    for (const collectionName of collectionNames) {
      const args = this.buildSearchArgs(command, query, limit);
      args.push("-c", collectionName);
      const result = await this.runQmd(args, { timeoutMs: this.qmd.limits.timeoutMs });
      const parsed = parseQmdQueryJson(result.stdout, result.stderr);
      for (const entry of parsed) {
        const normalizedDocId =
          typeof entry.docid === "string" && entry.docid.trim().length > 0
            ? entry.docid
            : undefined;
        if (!normalizedDocId) {
          continue;
        }
        const withCollection = {
          ...entry,
          docid: normalizedDocId,
          collection: entry.collection ?? collectionName,
        } satisfies QmdQueryResult;
        const prev = bestByDocId.get(normalizedDocId);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore =
          typeof withCollection.score === "number"
            ? withCollection.score
            : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByDocId.set(normalizedDocId, withCollection);
        }
      }
    }
    return [...bestByDocId.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private async runMcporterAcrossCollections(params: {
    tool: "search" | "vector_search" | "deep_search";
    query: string;
    limit: number;
    minScore: number;
    collectionNames: string[];
  }): Promise<QmdQueryResult[]> {
    const bestByDocId = new Map<string, QmdQueryResult>();
    for (const collectionName of params.collectionNames) {
      const parsed = await this.runQmdSearchViaMcporter({
        mcporter: this.qmd.mcporter,
        tool: params.tool,
        query: params.query,
        limit: params.limit,
        minScore: params.minScore,
        collection: collectionName,
        timeoutMs: this.qmd.limits.timeoutMs,
      });
      for (const entry of parsed) {
        if (typeof entry.docid !== "string" || !entry.docid.trim()) {
          continue;
        }
        const prev = bestByDocId.get(entry.docid);
        const prevScore = typeof prev?.score === "number" ? prev.score : Number.NEGATIVE_INFINITY;
        const nextScore = typeof entry.score === "number" ? entry.score : Number.NEGATIVE_INFINITY;
        if (!prev || nextScore > prevScore) {
          bestByDocId.set(entry.docid, entry);
        }
      }
    }
    return [...bestByDocId.values()].toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private listManagedCollectionNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const collection of this.qmd.collections) {
      const name = collection.name?.trim();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
    return names;
  }

  private buildCollectionFilterArgs(collectionNames: string[]): string[] {
    if (collectionNames.length === 0) {
      return [];
    }
    const names = collectionNames.filter(Boolean);
    return names.flatMap((name) => ["-c", name]);
  }

  private buildSearchArgs(
    command: "query" | "search" | "vsearch",
    query: string,
    limit: number,
  ): string[] {
    const normalizedQuery = command === "search" ? normalizeHanBm25Query(query) : query;
    if (command === "query") {
      return ["query", normalizedQuery, "--json", "-n", String(limit)];
    }
    return [command, normalizedQuery, "--json", "-n", String(limit)];
  }
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: appended.slice(-maxChars), truncated: true };
}
