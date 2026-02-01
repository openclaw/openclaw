import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyNonInteractiveMemoryDefaults, setupMemoryOptimization } from "./onboard-memory.js";

describe("onboard-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockPrompter = (multiselectValue: string[]): WizardPrompter => ({
    confirm: vi.fn().mockResolvedValue(true),
    note: vi.fn().mockResolvedValue(undefined),
    intro: vi.fn().mockResolvedValue(undefined),
    outro: vi.fn().mockResolvedValue(undefined),
    text: vi.fn().mockResolvedValue(""),
    select: vi.fn().mockResolvedValue(""),
    multiselect: vi.fn().mockResolvedValue(multiselectValue),
    progress: vi.fn().mockReturnValue({
      stop: vi.fn(),
      update: vi.fn(),
    }),
  });

  const createMockRuntime = (): RuntimeEnv => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  });

  describe("setupMemoryOptimization", () => {
    it("should enable all options when all are selected", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter([
        "hybrid-search",
        "embedding-cache",
        "memory-flush",
        "session-transcripts",
      ]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      // Hybrid search
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight).toBe(0.7);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.textWeight).toBe(0.3);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.candidateMultiplier).toBe(4);

      // Embedding cache
      expect(result.agents?.defaults?.memorySearch?.cache?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.cache?.maxEntries).toBe(50_000);

      // Memory flush
      expect(result.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(result.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(true);

      // Session transcripts
      expect(result.agents?.defaults?.memorySearch?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.experimental?.sessionMemory).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaBytes).toBe(50_000);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaMessages).toBe(25);
    });

    it("should enable only hybrid search when selected alone", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["hybrid-search"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight).toBe(0.7);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.textWeight).toBe(0.3);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.candidateMultiplier).toBe(4);

      // Other options should not be set
      expect(result.agents?.defaults?.memorySearch?.cache).toBeUndefined();
      expect(result.agents?.defaults?.compaction).toBeUndefined();
      expect(result.agents?.defaults?.memorySearch?.experimental).toBeUndefined();
    });

    it("should enable only embedding cache when selected alone", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["embedding-cache"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.memorySearch?.cache?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.cache?.maxEntries).toBe(50_000);

      // Other options should not be set
      expect(result.agents?.defaults?.memorySearch?.query).toBeUndefined();
      expect(result.agents?.defaults?.compaction).toBeUndefined();
      expect(result.agents?.defaults?.memorySearch?.experimental).toBeUndefined();
    });

    it("should enable only memory flush when selected alone", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["memory-flush"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(result.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(true);

      // Other options should not be set
      expect(result.agents?.defaults?.memorySearch).toBeUndefined();
    });

    it("should enable only session transcripts when selected alone", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["session-transcripts"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.memorySearch?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.experimental?.sessionMemory).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaBytes).toBe(50_000);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaMessages).toBe(25);

      // Other options should not be set
      expect(result.agents?.defaults?.memorySearch?.query).toBeUndefined();
      expect(result.agents?.defaults?.memorySearch?.cache).toBeUndefined();
      expect(result.agents?.defaults?.compaction).toBeUndefined();
    });

    it("should return config unchanged when user skips", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: "/my-workspace" } },
      };
      const prompter = createMockPrompter(["__skip__"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result).toEqual(cfg);
      // Only the intro note should be shown, no confirmation note
      expect(prompter.note).toHaveBeenCalledTimes(1);
    });

    it("should NOT overwrite existing hybrid search config values", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            memorySearch: {
              query: {
                hybrid: {
                  enabled: true,
                  vectorWeight: 0.5,
                  textWeight: 0.5,
                  candidateMultiplier: 8,
                },
              },
            },
          },
        },
      };
      const prompter = createMockPrompter(["hybrid-search"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      // Existing values must be preserved (nullish coalescing)
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight).toBe(0.5);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.textWeight).toBe(0.5);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.candidateMultiplier).toBe(8);
    });

    it("should NOT overwrite existing embedding cache config values", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            memorySearch: {
              cache: {
                enabled: false,
                maxEntries: 10_000,
              },
            },
          },
        },
      };
      const prompter = createMockPrompter(["embedding-cache"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.memorySearch?.cache?.enabled).toBe(false);
      expect(result.agents?.defaults?.memorySearch?.cache?.maxEntries).toBe(10_000);
    });

    it("should NOT overwrite existing compaction config values", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            compaction: {
              mode: "default",
              memoryFlush: {
                enabled: false,
              },
            },
          },
        },
      };
      const prompter = createMockPrompter(["memory-flush"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      // Existing values must be preserved
      expect(result.agents?.defaults?.compaction?.mode).toBe("default");
      expect(result.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(false);
    });

    it("should NOT overwrite existing session transcript config values", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            memorySearch: {
              enabled: false,
              experimental: {
                sessionMemory: false,
              },
              sync: {
                sessions: {
                  deltaBytes: 100_000,
                  deltaMessages: 50,
                },
              },
            },
          },
        },
      };
      const prompter = createMockPrompter(["session-transcripts"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.memorySearch?.enabled).toBe(false);
      expect(result.agents?.defaults?.memorySearch?.experimental?.sessionMemory).toBe(false);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaBytes).toBe(100_000);
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions?.deltaMessages).toBe(50);
    });

    it("should preserve unrelated existing config", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: "/existing-workspace",
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
        gateway: { mode: "local", port: 3000 },
      };
      const prompter = createMockPrompter(["hybrid-search"]);
      const runtime = createMockRuntime();

      const result = await setupMemoryOptimization(cfg, runtime, prompter);

      expect(result.agents?.defaults?.workspace).toBe("/existing-workspace");
      expect(result.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
      expect(result.gateway?.mode).toBe("local");
      expect(result.gateway?.port).toBe(3000);
      // And the new config should still be applied
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.enabled).toBe(true);
    });

    it("should show correct multiselect options", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["__skip__"]);
      const runtime = createMockRuntime();

      await setupMemoryOptimization(cfg, runtime, prompter);

      expect(prompter.multiselect).toHaveBeenCalledWith({
        message: "Enable memory optimizations?",
        options: [
          { value: "__skip__", label: "Skip for now" },
          {
            value: "hybrid-search",
            label: "🔍 Hybrid search (BM25 + vector)",
            hint: "70/30 vector/text blend with 4x candidate pool — improves recall for exact terms",
          },
          {
            value: "embedding-cache",
            label: "💾 Embedding cache",
            hint: "Caches embeddings in SQLite — saves API calls on reindex",
          },
          {
            value: "memory-flush",
            label: "🧠 Pre-compaction memory flush",
            hint: "Auto-saves notes before context compaction — prevents amnesia",
          },
          {
            value: "session-transcripts",
            label: "📜 Session transcript search",
            hint: "Indexes past transcripts via memory_search (experimental)",
          },
        ],
      });
    });

    it("should show intro and confirmation notes", async () => {
      const cfg: OpenClawConfig = {};
      const prompter = createMockPrompter(["hybrid-search", "memory-flush"]);
      const runtime = createMockRuntime();

      await setupMemoryOptimization(cfg, runtime, prompter);

      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(noteCalls).toHaveLength(2);

      // Intro note
      expect(noteCalls[0][0]).toContain("Memory optimization");
      expect(noteCalls[0][1]).toBe("Memory Optimization");

      // Confirmation note
      expect(noteCalls[1][0]).toContain("Enabled 2 optimizations: hybrid search, memory flush");
      expect(noteCalls[1][1]).toBe("Memory Configured");
    });

    it("should not mutate the original config", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: "/ws" } },
      };
      const original = JSON.stringify(cfg);
      const prompter = createMockPrompter(["hybrid-search"]);
      const runtime = createMockRuntime();

      await setupMemoryOptimization(cfg, runtime, prompter);

      expect(JSON.stringify(cfg)).toBe(original);
    });
  });

  describe("applyNonInteractiveMemoryDefaults", () => {
    it("should enable hybrid search, embedding cache, and memory flush", () => {
      const cfg: OpenClawConfig = {};

      const result = applyNonInteractiveMemoryDefaults(cfg);

      // Hybrid search
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight).toBe(0.7);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.textWeight).toBe(0.3);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.candidateMultiplier).toBe(4);

      // Embedding cache
      expect(result.agents?.defaults?.memorySearch?.cache?.enabled).toBe(true);
      expect(result.agents?.defaults?.memorySearch?.cache?.maxEntries).toBe(50_000);

      // Memory flush
      expect(result.agents?.defaults?.compaction?.mode).toBe("safeguard");
      expect(result.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(true);
    });

    it("should NOT enable session transcript search (experimental, opt-in only)", () => {
      const cfg: OpenClawConfig = {};

      const result = applyNonInteractiveMemoryDefaults(cfg);

      expect(result.agents?.defaults?.memorySearch?.experimental?.sessionMemory).toBeUndefined();
      expect(result.agents?.defaults?.memorySearch?.sync?.sessions).toBeUndefined();
    });

    it("should NOT overwrite existing values", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            memorySearch: {
              query: {
                hybrid: {
                  enabled: false,
                  vectorWeight: 0.9,
                },
              },
              cache: {
                enabled: false,
              },
            },
            compaction: {
              mode: "default",
              memoryFlush: {
                enabled: false,
              },
            },
          },
        },
      };

      const result = applyNonInteractiveMemoryDefaults(cfg);

      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.enabled).toBe(false);
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.vectorWeight).toBe(0.9);
      // textWeight was not set, so it should get the default
      expect(result.agents?.defaults?.memorySearch?.query?.hybrid?.textWeight).toBe(0.3);
      expect(result.agents?.defaults?.memorySearch?.cache?.enabled).toBe(false);
      expect(result.agents?.defaults?.compaction?.mode).toBe("default");
      expect(result.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(false);
    });

    it("should not mutate the original config", () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: "/ws" } },
      };
      const original = JSON.stringify(cfg);

      applyNonInteractiveMemoryDefaults(cfg);

      expect(JSON.stringify(cfg)).toBe(original);
    });

    it("should preserve unrelated config", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: "/existing",
            model: { primary: "openai/gpt-4o" },
          },
        },
        gateway: { port: 4000 },
      };

      const result = applyNonInteractiveMemoryDefaults(cfg);

      expect(result.agents?.defaults?.workspace).toBe("/existing");
      expect(result.agents?.defaults?.model?.primary).toBe("openai/gpt-4o");
      expect(result.gateway?.port).toBe(4000);
    });
  });
});
