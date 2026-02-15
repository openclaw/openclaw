import type { Command } from "commander";
import { glob } from "glob";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, writeConfigFile, readConfigFileSnapshot } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

const MEMORYROUTER_API = "https://api.memoryrouter.ai/v1";
const STATS_ENDPOINT = `${MEMORYROUTER_API}/memory/stats`;

interface MemoryLine {
  content: string;
  role: "user" | "assistant" | "system";
  timestamp: number;
}

interface VaultStats {
  memories: number;
  tokens: number;
  sessions: number;
}

/**
 * Validate memory key format (mk_ or mk- prefix)
 */
function isValidMemoryKey(key: string): boolean {
  return /^mk[_-]/.test(key);
}

/**
 * Mask a memory key for display (show first 6 and last 3 chars)
 */
function maskKey(key: string): string {
  if (key.length <= 12) {
    return key;
  }
  return `${key.slice(0, 6)}...${key.slice(-3)}`;
}

/**
 * Fetch vault stats from MemoryRouter API
 */
async function fetchVaultStats(key: string, endpoint?: string): Promise<VaultStats | null> {
  try {
    const statsUrl = endpoint ? `${endpoint.replace(/\/v1$/, "")}/v1/memory/stats` : STATS_ENDPOINT;

    const response = await fetch(statsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      totalVectors?: number;
      totalTokens?: number;
      sessions?: number;
    };
    return {
      memories: data.totalVectors ?? 0,
      tokens: data.totalTokens ?? 0,
      sessions: data.sessions ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a memory key against the MemoryRouter API
 */
async function validateMemoryKey(key: string, endpoint?: string): Promise<boolean> {
  try {
    const statsUrl = endpoint ? `${endpoint.replace(/\/v1$/, "")}/v1/memory/stats` : STATS_ENDPOINT;

    const response = await fetch(statsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

// Max size per item to avoid worker crashes (50KB is safe for embedding)
const MAX_ITEM_CHARS = 50_000;
// Target chunk size for splitting large files
const TARGET_CHUNK_CHARS = 8_000;

// Retry configuration
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retry for rate limits and transient errors.
 * Returns the successful response or throws after all retries exhausted.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  context: string,
): Promise<Response> {
  let lastError: Error | null = null;
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success - return immediately
      if (response.ok) {
        return response;
      }

      // Rate limited (429) or server error (5xx) - retry with backoff
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;
        const actualWait = Math.min(waitMs, MAX_BACKOFF_MS);

        if (attempt < MAX_RETRIES) {
          process.stdout.write(
            `\n    ${theme.warn("⏳")} ${context}: ${response.status} - retrying in ${Math.round(actualWait / 1000)}s (attempt ${attempt}/${MAX_RETRIES})...`,
          );
          await sleep(actualWait);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS); // Exponential backoff
          continue;
        }
      }

      // Non-retryable error (4xx except 429) - throw immediately
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Network errors - retry with backoff
      if (
        attempt < MAX_RETRIES &&
        (lastError.message.includes("fetch failed") ||
          lastError.message.includes("ECONNRESET") ||
          lastError.message.includes("ETIMEDOUT"))
      ) {
        process.stdout.write(
          `\n    ${theme.warn("⏳")} ${context}: Network error - retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt}/${MAX_RETRIES})...`,
        );
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

/**
 * Split text into chunks at paragraph/section boundaries.
 */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    // If adding this line exceeds limit, save current chunk
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    current += line + "\n";
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Convert a markdown file to JSONL memory lines.
 * Uses file mtime as timestamp.
 * Chunks large files to avoid worker crashes.
 */
async function fileToJsonl(filePath: string): Promise<MemoryLine[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const stat = await fs.stat(filePath);
  const timestamp = Math.floor(stat.mtimeMs);
  const filename = path.basename(filePath);

  const trimmed = content.trim();
  if (trimmed.length < 50) {
    return []; // Skip tiny files
  }

  // Small files: send as single item
  if (trimmed.length <= MAX_ITEM_CHARS) {
    return [
      {
        content: `[${filename}] ${trimmed}`,
        role: "user" as const,
        timestamp,
      },
    ];
  }

  // Large files: chunk at paragraph boundaries
  const chunks = chunkText(trimmed, TARGET_CHUNK_CHARS);
  return chunks.map((chunk, i) => ({
    content: `[${filename} part ${i + 1}/${chunks.length}] ${chunk}`,
    role: "user" as const,
    timestamp,
  }));
}

/**
 * Convert a session transcript (JSONL) to memory lines.
 * Preserves original timestamps from the session.
 *
 * Session JSONL format (Clawdbot/OpenClaw):
 *   Line 1: { type: "session", version: 3, id, timestamp, cwd }
 *   Lines 2+: { type: "message", id, parentId, timestamp, message: { role, content } }
 *
 * message.content can be:
 *   - A string: "hello"
 *   - An array:  [{ type: "text", text: "hello" }, { type: "tool_use", ... }]
 *
 * We extract text from both formats and pair with the message timestamp.
 */
async function sessionToJsonl(filePath: string): Promise<MemoryLine[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines: MemoryLine[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);

      // Skip non-message lines (session headers, tool results, etc.)
      if (parsed.type !== "message") {
        continue;
      }

      const msg = parsed.message;
      if (!msg || !msg.role) {
        continue;
      }

      // Only extract user and assistant messages (skip system)
      if (msg.role !== "user" && msg.role !== "assistant") {
        continue;
      }

      // Extract text content
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Extract text from content blocks, skip tool_use/tool_result blocks
        text = msg.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("\n");
      }

      if (!text || text.trim().length < 20) {
        continue; // Skip very short/empty messages
      }

      // Parse timestamp — session JSONL uses ISO strings
      let timestamp: number;
      if (typeof parsed.timestamp === "string") {
        timestamp = new Date(parsed.timestamp).getTime();
      } else if (typeof parsed.timestamp === "number") {
        timestamp = parsed.timestamp;
      } else if (typeof msg.timestamp === "number") {
        timestamp = msg.timestamp;
      } else {
        timestamp = Date.now();
      }

      lines.push({
        content: text.trim(),
        role: msg.role as "user" | "assistant",
        timestamp,
      });
    } catch {
      // Skip invalid JSON lines
    }
  }

  return lines;
}

/**
 * Check if a path exists
 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all files to upload from default locations.
 */
async function discoverFiles(workspacePath: string, stateDir: string): Promise<string[]> {
  const files: string[] = [];

  // 1. Root MEMORY.md
  const memoryMd = path.join(workspacePath, "MEMORY.md");
  if (await exists(memoryMd)) {
    files.push(memoryMd);
  }

  // 2. memory/**/*.md
  const memoryDir = path.join(workspacePath, "memory");
  if (await exists(memoryDir)) {
    const mdFiles = await glob("**/*.md", { cwd: memoryDir });
    files.push(...mdFiles.map((f) => path.join(memoryDir, f)));
  }

  // 3. AGENTS.md, TOOLS.md
  for (const contextFile of ["AGENTS.md", "TOOLS.md"]) {
    const p = path.join(workspacePath, contextFile);
    if (await exists(p)) {
      files.push(p);
    }
  }

  // 4. Session transcripts (from state dir, not workspace)
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  if (await exists(sessionsDir)) {
    const sessionFiles = await glob("*.jsonl", { cwd: sessionsDir });
    files.push(...sessionFiles.map((f) => path.join(sessionsDir, f)));
  }

  return files;
}

/**
 * Upload memories to MemoryRouter vault.
 */
async function runUpload(targetPath?: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.memoryRouter?.key) {
    defaultRuntime.error(
      `Error: MemoryRouter not configured. Run: ${theme.command("openclaw memoryrouter <key>")}`,
    );
    defaultRuntime.exit(1);
    return;
  }

  const endpoint = cfg.memoryRouter.endpoint ?? MEMORYROUTER_API;
  const uploadUrl = `${endpoint.replace(/\/v1$/, "")}/v1/memory/upload`;

  // Validate API reachability before processing files
  try {
    const validateRes = await fetch(`${endpoint.replace(/\/v1$/, "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!validateRes.ok) {
      defaultRuntime.error("Error: MemoryRouter API is not reachable. Check your connection.");
      defaultRuntime.exit(1);
      return;
    }
  } catch {
    defaultRuntime.error("Error: Could not reach MemoryRouter API. Check your connection.");
    defaultRuntime.exit(1);
    return;
  }

  const workspacePath = process.cwd();
  const stateDir = resolveStateDir();

  // Determine files to upload
  let files: string[];
  if (targetPath) {
    const resolved = path.resolve(targetPath);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const mdFiles = await glob("**/*.md", { cwd: resolved });
      const jsonlFiles = await glob("**/*.jsonl", { cwd: resolved });
      files = [...mdFiles, ...jsonlFiles].map((f) => path.join(resolved, f));
    } else {
      files = [resolved];
    }
  } else {
    files = await discoverFiles(workspacePath, stateDir);
  }

  if (files.length === 0) {
    defaultRuntime.log("No files found to upload.");
    return;
  }

  defaultRuntime.log(`📤 Uploading ${files.length} files to MemoryRouter...`);

  // Convert files to JSONL
  const allLines: MemoryLine[] = [];
  let skippedEmpty = 0;
  for (const file of files) {
    const displayName = path.basename(file);

    try {
      const lines = file.endsWith(".jsonl") ? await sessionToJsonl(file) : await fileToJsonl(file);
      if (lines.length === 0) {
        skippedEmpty++;
        continue;
      }
      allLines.push(...lines);
      defaultRuntime.log(
        `  ${displayName.padEnd(40, ".")} ${theme.success("✓")} (${lines.length} chunks)`,
      );
    } catch (err) {
      defaultRuntime.log(
        `  ${displayName.padEnd(40, ".")} ${theme.error("✗")} ${err instanceof Error ? err.message : "Error"}`,
      );
    }
  }
  if (skippedEmpty > 0) {
    defaultRuntime.log(theme.muted(`  Skipped ${skippedEmpty} files with no extractable content`));
  }

  if (allLines.length === 0) {
    defaultRuntime.log("\nNo content to upload.");
    return;
  }

  // Batch by both HTTP size limits AND MR worker limits
  // so we can send 100 items per HTTP request without hitting embedding limits.
  const MAX_BATCH_BYTES = 2_000_000; // 2MB - well under CF Workers 100MB body limit
  const MAX_BATCH_COUNT = 100;
  const batches: MemoryLine[][] = [];
  let currentBatch: MemoryLine[] = [];
  let currentBytes = 0;

  for (const line of allLines) {
    const lineBytes = JSON.stringify(line).length + 1; // +1 for newline
    if (currentBytes + lineBytes > MAX_BATCH_BYTES || currentBatch.length >= MAX_BATCH_COUNT) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [line];
      currentBytes = lineBytes;
    } else {
      currentBatch.push(line);
      currentBytes += lineBytes;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  defaultRuntime.log(
    `\nSending ${allLines.length} memories in ${batches.length} batch${batches.length > 1 ? "es" : ""}...`,
  );

  let totalProcessed = 0;
  let totalFailed = 0;

  // so rate limits are handled server-side. This is just pacing to avoid
  // overwhelming the HTTP endpoint.
  const BATCH_SLEEP_MS = 150;

  // Process batches with retry logic for failures
  for (let i = 0; i < batches.length; i++) {
    // Rate-limit pacing: sleep between batches (skip before first)
    if (i > 0) {
      await sleep(BATCH_SLEEP_MS);
    }

    let batch = batches[i];
    let batchAttempt = 0;
    let batchSuccess = false;
    let batchStored = 0;
    let batchFailed = 0;

    while (!batchSuccess && batchAttempt < MAX_RETRIES) {
      batchAttempt++;
      const jsonlBody = batch.map((line) => JSON.stringify(line)).join("\n");

      if (batches.length > 1) {
        if (batchAttempt === 1) {
          process.stdout.write(`  Batch ${i + 1}/${batches.length} (${batch.length} items)... `);
        }
      }

      try {
        const response = await fetchWithRetry(
          uploadUrl,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfg.memoryRouter.key}`,
              "Content-Type": "text/plain",
            },
            body: jsonlBody,
          },
          `Batch ${i + 1}`,
        );

        const result = (await response.json()) as {
          status: string;
          stats?: { inputItems?: number; stored?: number; failed?: number; chunks?: number };
          errors?: string[];
        };

        batchStored = result.stats?.stored ?? result.stats?.inputItems ?? batch.length;
        batchFailed = result.stats?.failed ?? 0;

        // Accept partial failures and move on — the DO's fallback already
        // isolated bad items individually. Retrying just re-hits the same bad content.
        batchSuccess = true;
        totalProcessed += batchStored;
        totalFailed += batchFailed;

        if (batches.length > 1) {
          if (batchFailed > 0) {
            const errHint = result.errors?.[0] ? ` (${result.errors[0].slice(0, 80)})` : "";
            defaultRuntime.log(
              `${theme.warn("⚠")} ${batchStored} stored, ${batchFailed} skipped${errHint}`,
            );
          } else {
            defaultRuntime.log(`${theme.success("✓")} ${batchStored} stored`);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (batchAttempt >= MAX_RETRIES) {
          if (batches.length > 1) {
            defaultRuntime.log(`${theme.error("✗")} Failed after ${MAX_RETRIES} attempts`);
          }
          defaultRuntime.error(`${theme.error("❌")} Batch ${i + 1} failed: ${errorMsg}`);
          // Count entire batch as failed
          totalFailed += batch.length;
          batchSuccess = true; // Mark as "done" to move on
        } else {
          const waitMs = Math.min(
            INITIAL_BACKOFF_MS * Math.pow(2, batchAttempt - 1),
            MAX_BACKOFF_MS,
          );
          process.stdout.write(
            `\n    ${theme.warn("⏳")} Error: ${errorMsg.slice(0, 50)} - retrying in ${Math.round(waitMs / 1000)}s...`,
          );
          await sleep(waitMs);
        }
      }
    }
  }

  defaultRuntime.log(`${theme.success("✅")} ${totalProcessed} vectors stored in vault`);
  if (totalFailed > 0) {
    const failRate = Math.round((totalFailed / (totalProcessed + totalFailed)) * 100);
    if (failRate > 10) {
      defaultRuntime.error(
        `${theme.error("❌")} ${totalFailed} failed (${failRate}%) - embedding failures, try again to backfill`,
      );
    } else {
      defaultRuntime.log(
        `${theme.warn("⚠️")} ${totalFailed} failed (${failRate}%) - run upload again to backfill`,
      );
    }
  }
}

/**
 * Delete all memories from vault.
 */
async function runDelete(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.memoryRouter?.key) {
    defaultRuntime.error("Error: MemoryRouter not configured.");
    defaultRuntime.exit(1);
    return;
  }

  const endpoint = cfg.memoryRouter.endpoint ?? MEMORYROUTER_API;
  const deleteUrl = `${endpoint.replace(/\/v1$/, "")}/v1/memory`;

  defaultRuntime.log("🗑️  Clearing MemoryRouter vault...");

  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${cfg.memoryRouter.key}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    defaultRuntime.error(`${theme.error("❌")} Delete failed: ${response.status} ${errorText}`);
    defaultRuntime.exit(1);
    return;
  }

  const result = (await response.json()) as { status?: string; message?: string };
  defaultRuntime.log(
    `${theme.success("✅")} Vault cleared (${result.message ?? result.status ?? "success"})`,
  );
}

/**
 * Register the memoryrouter CLI commands
 */
export function registerMemoryRouterCli(program: Command): void {
  const mr = program
    .command("memoryrouter")
    .description("Configure MemoryRouter memory integration")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/integrations/memoryrouter", "memoryrouter.ai/docs")}\n`,
    );

  // Enable with key: clawdbot memoryrouter mk_xxx
  mr.argument("[key]", "Memory key (mk_xxx) to enable MemoryRouter").action(
    async (key?: string) => {
      if (!key) {
        // No key provided, show status
        const cfg = loadConfig();
        const mrConfig = cfg.memoryRouter;

        defaultRuntime.log(theme.heading("MemoryRouter Status"));
        defaultRuntime.log("───────────────────────────");
        defaultRuntime.log(
          `Enabled:     ${mrConfig?.enabled ? theme.success("✓ Yes") : theme.muted("✗ No")}`,
        );
        if (mrConfig?.key) {
          defaultRuntime.log(`Key:         ${maskKey(mrConfig.key)}`);
        }
        defaultRuntime.log(`Endpoint:    ${mrConfig?.endpoint ?? MEMORYROUTER_API}`);
        defaultRuntime.log(
          `Fallback:    ${mrConfig?.fallbackOnUnsupported !== false ? "On" : "Off"}`,
        );

        // Fetch vault stats if enabled
        if (mrConfig?.enabled && mrConfig?.key) {
          const stats = await fetchVaultStats(mrConfig.key, mrConfig.endpoint);
          if (stats) {
            defaultRuntime.log("");
            defaultRuntime.log(theme.heading("Vault Stats:"));
            defaultRuntime.log(`  Memories:  ${stats.memories.toLocaleString()}`);
            defaultRuntime.log(`  Tokens:    ${formatTokens(stats.tokens)}`);
            defaultRuntime.log(`  Sessions:  ${stats.sessions}`);
          }
        }
        return;
      }

      // Enable with key
      if (!isValidMemoryKey(key)) {
        defaultRuntime.error(`${theme.error("Error:")} Memory key must start with mk_ or mk-`);
        defaultRuntime.exit(1);
        return;
      }

      // Validate key against API
      defaultRuntime.log("Validating memory key...");
      const valid = await validateMemoryKey(key);
      if (!valid) {
        defaultRuntime.log(
          `${theme.warn("Warning:")} Could not validate memory key. It may still work if the API is temporarily unavailable.`,
        );
      }

      // Update config
      const snapshot = await readConfigFileSnapshot();
      const cfg = snapshot.config;
      cfg.memoryRouter = {
        ...cfg.memoryRouter,
        enabled: true,
        key,
      };
      await writeConfigFile(cfg);

      defaultRuntime.log(`${theme.success("✓")} MemoryRouter enabled. Memory key: ${maskKey(key)}`);
    },
  );

  // Disable: clawdbot memoryrouter off
  mr.command("off")
    .description("Disable MemoryRouter (direct provider access)")
    .action(async () => {
      const snapshot = await readConfigFileSnapshot();
      const cfg = snapshot.config;
      if (cfg.memoryRouter) {
        cfg.memoryRouter.enabled = false;
      }
      await writeConfigFile(cfg);

      defaultRuntime.log(`${theme.success("✓")} MemoryRouter disabled.`);
    });

  // Status: clawdbot memoryrouter status
  mr.command("status")
    .description("Show MemoryRouter status and vault stats")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const mrConfig = cfg.memoryRouter;

      if (opts.json) {
        const stats =
          mrConfig?.enabled && mrConfig?.key
            ? await fetchVaultStats(mrConfig.key, mrConfig.endpoint)
            : null;
        defaultRuntime.log(
          JSON.stringify(
            {
              enabled: mrConfig?.enabled ?? false,
              key: mrConfig?.key ? maskKey(mrConfig.key) : null,
              endpoint: mrConfig?.endpoint ?? MEMORYROUTER_API,
              fallbackOnUnsupported: mrConfig?.fallbackOnUnsupported !== false,
              stats,
            },
            null,
            2,
          ),
        );
        return;
      }

      defaultRuntime.log(theme.heading("MemoryRouter Status"));
      defaultRuntime.log("───────────────────────────");
      defaultRuntime.log(
        `Enabled:     ${mrConfig?.enabled ? theme.success("✓ Yes") : theme.muted("✗ No")}`,
      );
      if (mrConfig?.key) {
        defaultRuntime.log(`Key:         ${maskKey(mrConfig.key)}`);
      }
      defaultRuntime.log(`Endpoint:    ${mrConfig?.endpoint ?? MEMORYROUTER_API}`);
      defaultRuntime.log(
        `Fallback:    ${mrConfig?.fallbackOnUnsupported !== false ? "On" : "Off"}`,
      );

      // Fetch vault stats if enabled
      if (mrConfig?.enabled && mrConfig?.key) {
        const stats = await fetchVaultStats(mrConfig.key, mrConfig.endpoint);
        if (stats) {
          defaultRuntime.log("");
          defaultRuntime.log(theme.heading("Vault Stats:"));
          defaultRuntime.log(`  Memories:  ${stats.memories.toLocaleString()}`);
          defaultRuntime.log(`  Tokens:    ${formatTokens(stats.tokens)}`);
          defaultRuntime.log(`  Sessions:  ${stats.sessions}`);
        }
      }
    });

  // Upload: clawdbot memoryrouter upload [path]
  mr.command("upload [path]")
    .description("Upload memory files to MemoryRouter vault")
    .action(async (targetPath?: string) => {
      await runUpload(targetPath);
    });

  // Delete: clawdbot memoryrouter delete
  mr.command("delete")
    .description("Clear all memories from vault")
    .action(async () => {
      await runDelete();
    });

  // Setup: clawdbot memoryrouter setup (interactive wizard)
  mr.command("setup")
    .description("Interactive setup wizard for MemoryRouter")
    .action(async () => {
      const { createClackPrompter } = await import("../wizard/clack-prompter.js");
      const { setupMemoryRouter } = await import("../commands/onboard-memoryrouter.js");
      const { writeConfigFile, readConfigFileSnapshot } = await import("../config/config.js");

      const prompter = createClackPrompter();

      await prompter.note(
        [
          "MemoryRouter gives your AI persistent memory across all conversations.",
          "",
          "Every message is automatically stored and relevant context is retrieved",
          "when you ask questions — like having an AI that actually remembers you.",
          "",
          "Sign up at memoryrouter.ai to get your memory key.",
        ].join("\n"),
        "MemoryRouter",
      );

      const snapshot = await readConfigFileSnapshot();
      let cfg = snapshot.config;

      cfg = await setupMemoryRouter(cfg, prompter);

      if (cfg.memoryRouter?.enabled) {
        await writeConfigFile(cfg);
        defaultRuntime.log(`${theme.success("✓")} MemoryRouter configured and enabled!`);
        defaultRuntime.log(
          `\nRun ${theme.command("openclaw memoryrouter upload")} to upload your existing memories.`,
        );
      } else {
        defaultRuntime.log("Setup cancelled.");
      }
    });
}

/**
 * Format token count for display (e.g., 1.2M, 500K)
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}
