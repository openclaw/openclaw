import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * Memory optimization step for the onboarding wizard.
 *
 * Offers users a curated set of memory enhancements that dramatically improve
 * agent recall, search quality, and context persistence across compactions.
 *
 * These settings are off or minimal by default but provide significant benefits
 * when enabled — especially for long-running agents with rich conversation history.
 */
export async function setupMemoryOptimization(
  cfg: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Memory optimization improves how your agent remembers, searches, and",
      "persists context across sessions and compactions.",
      "",
      "These features are safe to enable and can dramatically improve recall.",
      "",
      "Learn more: https://docs.openclaw.ai/concepts/memory",
    ].join("\n"),
    "Memory",
  );

  const enableMemory = await prompter.confirm({
    message: "Enable advanced memory optimization?",
    initialValue: true,
  });

  if (!enableMemory) {
    return cfg;
  }

  const features = await prompter.multiselect({
    message: "Select memory features to enable",
    options: [
      {
        value: "hybrid-search",
        label: "🔍 Hybrid search (BM25 + vector)",
        hint: "Combines semantic + keyword matching for better recall of names, IDs, and exact terms",
      },
      {
        value: "embedding-cache",
        label: "💾 Embedding cache",
        hint: "Caches embeddings so reindexing is faster and cheaper (saves API calls)",
      },
      {
        value: "memory-flush",
        label: "🧠 Pre-compaction memory flush",
        hint: "Auto-saves durable notes before context is compacted (prevents memory loss)",
      },
      {
        value: "session-memory",
        label: "📜 Session transcript search",
        hint: "Index and search past session transcripts (experimental, opt-in)",
      },
    ],
  });

  if (features.length === 0) {
    return cfg;
  }

  const selected = new Set(features);
  const agentDefaults = cfg.agents?.defaults ?? {};
  const memorySearch = agentDefaults.memorySearch ?? {};
  const compaction = agentDefaults.compaction ?? {};

  // Hybrid search: combine vector similarity with BM25 keyword relevance
  if (selected.has("hybrid-search")) {
    memorySearch.query = {
      ...memorySearch.query,
      hybrid: {
        enabled: true,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 4,
      },
    };
  }

  // Embedding cache: avoid re-embedding unchanged chunks
  if (selected.has("embedding-cache")) {
    memorySearch.cache = {
      enabled: true,
      maxEntries: 50000,
    };
  }

  // Pre-compaction memory flush: save notes before context wipe
  if (selected.has("memory-flush")) {
    compaction.memoryFlush = {
      enabled: true,
    };
  }

  // Session transcript indexing: search past conversations
  if (selected.has("session-memory")) {
    memorySearch.sources = ["memory", "sessions"];
    memorySearch.experimental = {
      ...memorySearch.experimental,
      sessionMemory: true,
    };
    // Lower thresholds for faster session indexing
    memorySearch.sync = {
      ...memorySearch.sync,
      sessions: {
        deltaBytes: 50000,
        deltaMessages: 25,
      },
    };
  }

  const next: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...agentDefaults,
        memorySearch: {
          ...agentDefaults.memorySearch,
          ...memorySearch,
        },
        compaction: {
          ...agentDefaults.compaction,
          ...compaction,
        },
      },
    },
  };

  const summary = features.map((f) => {
    switch (f) {
      case "hybrid-search":
        return "Hybrid search (70% semantic + 30% keyword)";
      case "embedding-cache":
        return "Embedding cache (up to 50k entries)";
      case "memory-flush":
        return "Pre-compaction memory flush";
      case "session-memory":
        return "Session transcript search (faster indexing thresholds)";
      default:
        return f;
    }
  });

  await prompter.note(
    [
      `Enabled ${features.length} memory feature${features.length > 1 ? "s" : ""}:`,
      "",
      ...summary.map((s) => `  ✓ ${s}`),
      "",
      "Your agent will now have significantly improved recall and context",
      "persistence across sessions and compactions.",
    ].join("\n"),
    "Memory Optimized",
  );

  return next;
}
