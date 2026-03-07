import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const MEMORY_OPTIONS = {
  hybridSearch: "hybrid-search",
  embeddingCache: "embedding-cache",
  memoryFlush: "memory-flush",
  sessionTranscripts: "session-transcripts",
} as const;

export async function setupMemoryOptimization(
  cfg: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Memory optimization surfaces powerful but non-obvious features",
      "that dramatically improve recall, caching, and context persistence.",
      "",
      "All options use safe defaults and never overwrite your existing config.",
    ].join("\n"),
    "Memory Optimization",
  );

  const selected = await prompter.multiselect({
    message: "Enable memory optimizations?",
    options: [
      { value: "__skip__", label: "Skip for now" },
      {
        value: MEMORY_OPTIONS.hybridSearch,
        label: "🔍 Hybrid search (BM25 + vector)",
        hint: "70/30 vector/text blend with 4x candidate pool — improves recall for exact terms",
      },
      {
        value: MEMORY_OPTIONS.embeddingCache,
        label: "💾 Embedding cache",
        hint: "Caches embeddings in SQLite — saves API calls on reindex",
      },
      {
        value: MEMORY_OPTIONS.memoryFlush,
        label: "🧠 Pre-compaction memory flush",
        hint: "Auto-saves notes before context compaction — prevents amnesia",
      },
      {
        value: MEMORY_OPTIONS.sessionTranscripts,
        label: "📜 Session transcript search",
        hint: "Indexes past transcripts via memory_search (experimental)",
      },
    ],
  });

  const choices = new Set((selected ?? []).filter((v) => v !== "__skip__"));
  if (choices.size === 0) {
    return cfg;
  }

  let next = structuredClone(cfg);

  if (choices.has(MEMORY_OPTIONS.hybridSearch)) {
    next = applyHybridSearch(next);
  }

  if (choices.has(MEMORY_OPTIONS.embeddingCache)) {
    next = applyEmbeddingCache(next);
  }

  if (choices.has(MEMORY_OPTIONS.memoryFlush)) {
    next = applyMemoryFlush(next);
  }

  if (choices.has(MEMORY_OPTIONS.sessionTranscripts)) {
    next = applySessionTranscripts(next);
  }

  const labels: string[] = [];
  if (choices.has(MEMORY_OPTIONS.hybridSearch)) {
    labels.push("hybrid search");
  }
  if (choices.has(MEMORY_OPTIONS.embeddingCache)) {
    labels.push("embedding cache");
  }
  if (choices.has(MEMORY_OPTIONS.memoryFlush)) {
    labels.push("memory flush");
  }
  if (choices.has(MEMORY_OPTIONS.sessionTranscripts)) {
    labels.push("session transcripts");
  }

  await prompter.note(
    [
      `Enabled ${labels.length} optimization${labels.length > 1 ? "s" : ""}: ${labels.join(", ")}`,
      "",
      "You can tune these later in your config under:",
      "  agents.defaults.memorySearch",
      "  agents.defaults.compaction",
    ].join("\n"),
    "Memory Configured",
  );

  return next;
}

// ── Helpers (safe deep-set with nullish coalescing) ──────────────────

function ensureAgentsDefaults(cfg: OpenClawConfig): OpenClawConfig {
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  return cfg;
}

function ensureMemorySearch(cfg: OpenClawConfig): OpenClawConfig {
  cfg = ensureAgentsDefaults(cfg);
  cfg.agents!.defaults!.memorySearch ??= {};
  return cfg;
}

function applyHybridSearch(cfg: OpenClawConfig): OpenClawConfig {
  cfg = ensureMemorySearch(cfg);
  const ms = cfg.agents!.defaults!.memorySearch!;
  ms.query ??= {};
  ms.query.hybrid ??= {};
  ms.query.hybrid.enabled ??= true;
  ms.query.hybrid.vectorWeight ??= 0.7;
  ms.query.hybrid.textWeight ??= 0.3;
  ms.query.hybrid.candidateMultiplier ??= 4;
  return cfg;
}

function applyEmbeddingCache(cfg: OpenClawConfig): OpenClawConfig {
  cfg = ensureMemorySearch(cfg);
  const ms = cfg.agents!.defaults!.memorySearch!;
  ms.cache ??= {};
  ms.cache.enabled ??= true;
  ms.cache.maxEntries ??= 50_000;
  return cfg;
}

function applyMemoryFlush(cfg: OpenClawConfig): OpenClawConfig {
  cfg = ensureAgentsDefaults(cfg);
  const d = cfg.agents!.defaults!;
  d.compaction ??= {};
  d.compaction.mode ??= "safeguard";
  d.compaction.memoryFlush ??= {};
  d.compaction.memoryFlush.enabled ??= true;
  return cfg;
}

function applySessionTranscripts(cfg: OpenClawConfig): OpenClawConfig {
  cfg = ensureMemorySearch(cfg);
  const ms = cfg.agents!.defaults!.memorySearch!;
  ms.enabled ??= true;
  ms.experimental ??= {};
  ms.experimental.sessionMemory ??= true;
  ms.sync ??= {};
  ms.sync.sessions ??= {};
  ms.sync.sessions.deltaBytes ??= 50_000;
  ms.sync.sessions.deltaMessages ??= 25;
  return cfg;
}

// ── Non-interactive defaults ─────────────────────────────────────────

/**
 * Apply sensible memory optimization defaults for non-interactive onboarding.
 * Enables hybrid search, embedding cache, and pre-compaction memory flush.
 * Session transcript search is experimental and opt-in only.
 */
export function applyNonInteractiveMemoryDefaults(cfg: OpenClawConfig): OpenClawConfig {
  let next = structuredClone(cfg);
  next = applyHybridSearch(next);
  next = applyEmbeddingCache(next);
  next = applyMemoryFlush(next);
  return next;
}
