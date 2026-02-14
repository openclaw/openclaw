import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { OpenClawConfig } from "../config/config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { deriveQmdScopeChannel, deriveQmdScopeChatType, isQmdScopeAllowed } from "./qmd-scope.js";
import {
  listSessionFilesForAgent,
  buildSessionEntry,
  type SessionFileEntry,
} from "./session-files.js";
import { requireNodeSqlite } from "./sqlite.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;
import type { ResolvedMemoryBackendConfig, ResolvedQmdConfig } from "./backend-config.js";
import { parseQmdQueryJson } from "./qmd-query-parser.js";

const log = createSubsystemLogger("memory");

const SNIPPET_HEADER_RE = /@@\s*-([0-9]+),([0-9]+)/;
const SEARCH_PENDING_UPDATE_WAIT_MS = 500;
const MAX_QMD_OUTPUT_CHARS = 200_000;

type CollectionRoot = {
  path: string;
  kind: MemorySource;
};

type SessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

export class QmdMemoryManager implements MemorySearchManager {
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const manager = new QmdMemoryManager({ cfg: params.cfg, agentId: params.agentId, resolved });
    await manager.initialize();
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

  private async initialize(): Promise<void> {
    await fs.mkdir(this.xdgConfigHome, { recursive: true });
    await fs.mkdir(this.xdgCacheHome, { recursive: true });
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });

    // QMD stores its ML models under $XDG_CACHE_HOME/qmd/models/.  Because we
    // override XDG_CACHE_HOME to isolate the index per-agent, qmd would not
    // find models installed at the default location (~/.cache/qmd/models/) and
    // would attempt to re-download them on every invocation.  Symlink the
    // default models directory into our custom cache so the index stays
    // isolated while models are shared.
    await this.symlinkSharedModels();

    this.bootstrapCollections();
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
    const existing = new Set<string>();
    try {
      const result = await this.runQmd(["collection", "list", "--json"], {
        timeoutMs: this.qmd.update.commandTimeoutMs,
      });
      const parsed = JSON.parse(result.stdout) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "string") {
            existing.add(entry);
          } else if (entry && typeof entry === "object") {
            const name = (entry as { name?: unknown }).name;
            if (typeof name === "string") {
              existing.add(name);
            }
          }
        }
      }
    } catch {
      // ignore; older qmd versions might not support list --json.
    }

    for (const collection of this.qmd.collections) {
      if (existing.has(collection.name)) {
        continue;
      }
      try {
        await this.runQmd(
          [
            "collection",
            "add",
            collection.path,
            "--name",
            collection.name,
            "--mask",
            collection.pattern,
          ],
          {
            timeoutMs: this.qmd.update.commandTimeoutMs,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Idempotency: qmd exits non-zero if the collection name already exists.
        if (message.toLowerCase().includes("already exists")) {
          continue;
        }
        if (message.toLowerCase().includes("exists")) {
          continue;
        }
        log.warn(`qmd collection add failed for ${collection.name}: ${message}`);
      }
    }
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
    const collectionFilterArgs = this.buildCollectionFilterArgs();
    if (collectionFilterArgs.length === 0) {
      log.warn("qmd query skipped: no managed collections configured");
      return [];
    }
    const qmdSearchCommand = this.qmd.searchMode;
    const args = this.buildSearchArgs(qmdSearchCommand, trimmed, limit);

    // Always scope to managed collections (default + custom). Even for `search`/`vsearch`,
    // pass collection filters; if a given QMD build rejects these flags, we fall back to `query`.
    args.push(...collectionFilterArgs);
    let stdout: string;
    let stderr: string;
    try {
      const result = await this.runQmd(args, { timeoutMs: this.qmd.limits.timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      if (qmdSearchCommand !== "query" && this.isUnsupportedQmdOptionError(err)) {
        log.warn(
          `qmd ${qmdSearchCommand} does not support configured flags; retrying search with qmd query`,
        );
        try {
          const fallbackArgs = this.buildSearchArgs("query", trimmed, limit);
          fallbackArgs.push(...collectionFilterArgs);
          const fallback = await this.runQmd(fallbackArgs, {
            timeoutMs: this.qmd.limits.timeoutMs,
          });
          stdout = fallback.stdout;
          stderr = fallback.stderr;
        } catch (fallbackErr) {
          log.warn(`qmd query fallback failed: ${String(fallbackErr)}`);
          throw fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
        }
      } else {
        log.warn(`qmd ${qmdSearchCommand} failed: ${String(err)}`);
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    const parsed = parseQmdQueryJson(stdout, stderr);
    const results: MemorySearchResult[] = [];
    for (const entry of parsed) {
      const doc = await this.resolveDocLocation(entry.docid);
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
    return this.clampResultsByInjectedChars(results.slice(0, limit));
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
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("path required");
    }
    if (params.from !== undefined || params.lines !== undefined) {
      const text = await this.readPartialText(absPath, params.from, params.lines);
      return { text, path: relPath };
    }
    const content = await fs.readFile(absPath, "utf-8");
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
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
      await this.runQmd(["update"], { timeoutMs: this.qmd.update.updateTimeoutMs });
      const embedIntervalMs = this.qmd.update.embedIntervalMs;
      const shouldEmbed =
        Boolean(force) ||
        this.lastEmbedAt === null ||
        (embedIntervalMs > 0 && Date.now() - this.lastEmbedAt > embedIntervalMs);
      if (shouldEmbed) {
        try {
          await this.runQmd(["embed"], { timeoutMs: this.qmd.update.embedTimeoutMs });
          this.lastEmbedAt = Date.now();
        } catch (err) {
          log.warn(`qmd embed failed (${reason}): ${String(err)}`);
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
      const child = spawn(this.qmd.command, args, {
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

  private async readPartialText(absPath: string, from?: number, lines?: number): Promise<string> {
    const start = Math.max(1, from ?? 1);
    const count = Math.max(1, lines ?? Number.POSITIVE_INFINITY);
    const handle = await fs.open(absPath);
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
    return selected.slice(0, count).join("\n");
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
    if (!existing.has("sessions")) {
      return "sessions";
    }
    let counter = 2;
    let candidate = `sessions-${counter}`;
    while (existing.has(candidate)) {
      counter += 1;
      candidate = `sessions-${counter}`;
    }
    return candidate;
  }

  private async resolveDocLocation(
    docid?: string,
  ): Promise<{ rel: string; abs: string; source: MemorySource } | null> {
    if (!docid) {
      return null;
    }
    const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
    if (!normalized) {
      return null;
    }
    const cached = this.docPathCache.get(normalized);
    if (cached) {
      return cached;
    }
    const db = this.ensureDb();
    let row: { collection: string; path: string } | undefined;
    try {
      const exact = db
        .prepare("SELECT collection, path FROM documents WHERE hash = ? AND active = 1 LIMIT 1")
        .get(normalized) as { collection: string; path: string } | undefined;
      row = exact;
      if (!row) {
        row = db
          .prepare(
            "SELECT collection, path FROM documents WHERE hash LIKE ? AND active = 1 LIMIT 1",
          )
          .get(`${normalized}%`) as { collection: string; path: string } | undefined;
      }
    } catch (err) {
      if (this.isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving doc path: ${String(err)}`);
        throw this.createQmdBusyError(err);
      }
      throw err;
    }
    if (!row) {
      return null;
    }
    const location = this.toDocLocation(row.collection, row.path);
    if (!location) {
      return null;
    }
    this.docPathCache.set(normalized, location);
    return location;
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

  private buildCollectionFilterArgs(): string[] {
    const names = this.qmd.collections.map((collection) => collection.name).filter(Boolean);
    if (names.length === 0) {
      return [];
    }
    return names.flatMap((name) => ["-c", name]);
  }

  private buildSearchArgs(
    command: "query" | "search" | "vsearch",
    query: string,
    limit: number,
  ): string[] {
    if (command === "query") {
      return ["query", query, "--json", "-n", String(limit)];
    }
    return [command, query, "--json", "-n", String(limit)];
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
