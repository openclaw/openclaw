import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { MemorySyncError } from "./manager-sync-ops.js";

type MemoryIndexModule = typeof import("./index.js");

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

let embedBatchCalls = 0;
let embedBatchInputCalls = 0;
let providerCalls: Array<{ provider?: string; model?: string; outputDimensionality?: number }> = [];
let embedBatchOverride: ((texts: string[]) => Promise<number[][]>) | undefined;

function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  const alpha = lower.split("alpha").length - 1;
  const beta = lower.split("beta").length - 1;
  const image = lower.split("image").length - 1;
  const audio = lower.split("audio").length - 1;
  return [alpha, beta, image, audio];
}

vi.mock("./embeddings.js", () => {
  return {
    createEmbeddingProvider: async (options: {
      provider?: string;
      model?: string;
      outputDimensionality?: number;
    }) => {
      providerCalls.push({
        provider: options.provider,
        model: options.model,
        outputDimensionality: options.outputDimensionality,
      });
      const providerId = options.provider === "gemini" ? "gemini" : "mock";
      const model = options.model ?? "mock-embed";
      return {
        requestedProvider: options.provider ?? "openai",
        provider: {
          id: providerId,
          model,
          embedQuery: async (text: string) => embedText(text),
          embedBatch: async (texts: string[]) => {
            embedBatchCalls += 1;
            if (embedBatchOverride) {
              return await embedBatchOverride(texts);
            }
            return texts.map(embedText);
          },
          ...(providerId === "gemini"
            ? {
                embedBatchInputs: async (
                  inputs: Array<{
                    text: string;
                    parts?: Array<
                      | { type: "text"; text: string }
                      | { type: "inline-data"; mimeType: string; data: string }
                    >;
                  }>,
                ) => {
                  embedBatchInputCalls += 1;
                  return inputs.map((input) => {
                    const inlineData = input.parts?.find((part) => part.type === "inline-data");
                    if (inlineData?.type === "inline-data" && inlineData.data.length > 9000) {
                      throw new Error("payload too large");
                    }
                    const mimeType =
                      inlineData?.type === "inline-data" ? inlineData.mimeType : undefined;
                    if (mimeType?.startsWith("image/")) {
                      return [0, 0, 1, 0];
                    }
                    if (mimeType?.startsWith("audio/")) {
                      return [0, 0, 0, 1];
                    }
                    return embedText(input.text);
                  });
                },
              }
            : {}),
        },
        ...(providerId === "gemini"
          ? {
              gemini: {
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                headers: {},
                model,
                modelPath: `models/${model}`,
                apiKeys: ["test-key"],
                outputDimensionality: options.outputDimensionality,
              },
            }
          : {}),
      };
    },
  };
});

describe("memory index", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let extraDir = "";
  let indexVectorPath = "";
  let indexMainPath = "";
  let indexExtraPath = "";
  let indexMultimodalPath = "";
  let indexStatusPath = "";
  let indexSourceChangePath = "";
  let indexModelPath = "";
  let sourceChangeStateDir = "";
  const sourceChangeSessionLogLines = [
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "session change test user line" }],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "session change test assistant line" }],
      },
    }),
  ].join("\n");

  const managersForCleanup = new Set<MemoryIndexManager>();

  beforeAll(async () => {
    vi.resetModules();
    await import("./test-runtime-mocks.js");
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fixtures-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    extraDir = path.join(workspaceDir, "extra");
    indexMainPath = path.join(workspaceDir, "index-main.sqlite");
    indexVectorPath = path.join(workspaceDir, "index-vector.sqlite");
    indexExtraPath = path.join(workspaceDir, "index-extra.sqlite");
    indexMultimodalPath = path.join(workspaceDir, "index-multimodal.sqlite");
    indexStatusPath = path.join(workspaceDir, "index-status.sqlite");
    indexSourceChangePath = path.join(workspaceDir, "index-source-change.sqlite");
    indexModelPath = path.join(workspaceDir, "index-model-change.sqlite");
    sourceChangeStateDir = path.join(fixtureRoot, "state-source-change");

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-12.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
  });

  afterAll(async () => {
    await Promise.all(Array.from(managersForCleanup).map((manager) => manager.close()));
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await closeAllMemorySearchManagers();
    managersForCleanup.clear();
  });

  beforeEach(async () => {
    // Perf: most suites don't need atomic swap behavior for full reindexes.
    // Keep atomic reindex tests on the safe path.
    vi.stubEnv("OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX", "1");
    embedBatchCalls = 0;
    embedBatchInputCalls = 0;
    providerCalls = [];
    embedBatchOverride = undefined;

    mkdirSync(memoryDir, { recursive: true });

    // Clean additional paths that may have been created by earlier cases.
    rmSync(extraDir, { recursive: true, force: true });
  });

  function resetManagerForTest(manager: MemoryIndexManager) {
    // These tests reuse managers for performance. Clear the index + embedding
    // cache to keep each test fully isolated.
    const db = (
      manager as unknown as {
        db: {
          exec: (sql: string) => void;
          prepare: (sql: string) => { get: (name: string) => { name?: string } | undefined };
        };
      }
    ).db;
    (manager as unknown as { resetIndex: () => void }).resetIndex();
    const embeddingCacheTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("embedding_cache");
    if (embeddingCacheTable?.name === "embedding_cache") {
      db.exec("DELETE FROM embedding_cache");
    }
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { sessionsDirty: boolean }).sessionsDirty = false;
  }

  type TestCfg = Parameters<typeof getMemorySearchManager>[0]["cfg"];

  function createCfg(params: {
    storePath: string;
    extraPaths?: string[];
    sources?: Array<"memory" | "sessions">;
    sessionMemory?: boolean;
    provider?: "openai" | "gemini";
    model?: string;
    outputDimensionality?: number;
    multimodal?: {
      enabled?: boolean;
      modalities?: Array<"image" | "audio" | "all">;
      maxFileBytes?: number;
    };
    vectorEnabled?: boolean;
    cacheEnabled?: boolean;
    minScore?: number;
    onSearch?: boolean;
    hybrid?: { enabled: boolean; vectorWeight?: number; textWeight?: number };
  }): TestCfg {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: params.provider ?? "openai",
            model: params.model ?? "mock-embed",
            outputDimensionality: params.outputDimensionality,
            store: { path: params.storePath, vector: { enabled: params.vectorEnabled ?? false } },
            // Perf: keep test indexes to a single chunk to reduce sqlite work.
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: params.onSearch ?? true },
            query: {
              minScore: params.minScore ?? 0,
              hybrid: params.hybrid ?? { enabled: false },
            },
            cache: params.cacheEnabled ? { enabled: true } : undefined,
            extraPaths: params.extraPaths,
            multimodal: params.multimodal,
            sources: params.sources,
            experimental: { sessionMemory: params.sessionMemory ?? false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  function requireManager(
    result: Awaited<ReturnType<typeof getMemorySearchManager>>,
    missingMessage = "manager missing",
  ): MemoryIndexManager {
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error(missingMessage);
    }
    return result.manager as MemoryIndexManager;
  }

  async function getPersistentManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    resetManagerForTest(manager);
    return manager;
  }

  async function getFreshManager(cfg: TestCfg): Promise<MemoryIndexManager> {
    const { getRequiredMemoryIndexManager } = await import("./test-manager-helpers.js");
    return await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
  }

  async function expectHybridKeywordSearchFindsMemory(cfg: TestCfg) {
    const manager = await getFreshManager(cfg);
    try {
      const status = manager.status();
      if (!status.fts?.available) {
        return;
      }

      await manager.sync({ reason: "test" });
      const results = await manager.search("zebra");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
    } finally {
      await manager.close?.();
    }
  }

  it.skip("indexes memory files and searches", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      hybrid: { enabled: true, vectorWeight: 0.5, textWeight: 0.5 },
    });
    const manager = await getFreshManager(cfg);
    try {
      await manager.sync({ reason: "test" });
      const results = await manager.search("alpha");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.path).toContain("memory/2026-01-12.md");
      const status = manager.status();
      expect(status.sourceCounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "memory",
            files: status.files,
            chunks: status.chunks,
          }),
        ]),
      );
    } finally {
      await manager.close?.();
    }
  });

  it("indexes multimodal image and audio files from extra paths with Gemini structured inputs", async () => {
    const mediaDir = path.join(workspaceDir, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));

    const cfg = createCfg({
      storePath: indexMultimodalPath,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);
  });

  it("skips oversized multimodal inputs without aborting sync", async () => {
    const mediaDir = path.join(workspaceDir, "media-oversize");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "huge.png"), Buffer.alloc(7000, 1));

    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-oversize-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image"] },
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(0);
    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("huge.png"))).toBe(false);

    const alphaResults = await manager.search("alpha");
    expect(alphaResults.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(true);

    await manager.close?.();
  });

  it("reindexes a multimodal file after a transient mid-sync disappearance", async () => {
    const mediaDir = path.join(workspaceDir, "media-race");
    const imagePath = path.join(mediaDir, "diagram.png");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from("png"));

    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-race-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image"] },
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    const realReadFile = fs.readFile.bind(fs);
    let imageReads = 0;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const [targetPath] = args;
      if (typeof targetPath === "string" && targetPath === imagePath) {
        imageReads += 1;
        if (imageReads === 2) {
          const err = Object.assign(
            new Error(`ENOENT: no such file or directory, open '${imagePath}'`),
            {
              code: "ENOENT",
            },
          ) as NodeJS.ErrnoException;
          throw err;
        }
      }
      return await realReadFile(...args);
    });

    await manager.sync({ reason: "test" });
    readSpy.mockRestore();

    const callsAfterFirstSync = embedBatchInputCalls;
    (manager as unknown as { dirty: boolean }).dirty = true;
    await manager.sync({ reason: "test" });

    expect(embedBatchInputCalls).toBeGreaterThan(callsAfterFirstSync);
    const results = await manager.search("image");
    expect(results.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    await manager.close?.();
  });

  it("keeps dirty false in status-only manager after prior indexing", async () => {
    const cfg = createCfg({ storePath: indexStatusPath });

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    const firstManager = requireManager(first);
    await firstManager.sync?.({ reason: "test" });
    await firstManager.close?.();
    const providerCallsBeforeStatus = providerCalls.length;

    const statusOnly = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });
    const statusManager = requireManager(statusOnly, "status manager missing");
    const status = statusManager.status();
    expect(status.dirty).toBe(false);
    expect(status.provider).toBe("openai");
    expect(providerCalls).toHaveLength(providerCallsBeforeStatus);
    await statusManager.close?.();
  });

  it("does not cache builtin status-only managers across repeated requests", async () => {
    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-status-${randomUUID()}.sqlite`),
    });

    const first = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });
    const second = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
    });

    const firstManager = requireManager(first, "first status manager missing");
    const secondManager = requireManager(second, "second status manager missing");
    expect(secondManager).not.toBe(firstManager);

    await firstManager.close?.();
    await secondManager.close?.();
  });

  it("reindexes sessions when source config adds sessions to an existing index", async () => {
    const stateDir = sourceChangeStateDir;
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session-source-change.jsonl"),
      `${sourceChangeSessionLogLines}\n`,
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const firstCfg = createCfg({
      storePath: indexSourceChangePath,
      sources: ["memory"],
      sessionMemory: false,
    });
    const secondCfg = createCfg({
      storePath: indexSourceChangePath,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });

    try {
      const first = await getMemorySearchManager({ cfg: firstCfg, agentId: "main" });
      const firstManager = requireManager(first);
      await firstManager.sync?.({ reason: "test" });
      const firstStatus = firstManager.status();
      expect(
        firstStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.files ?? 0,
      ).toBe(0);
      await firstManager.close?.();

      const second = await getMemorySearchManager({ cfg: secondCfg, agentId: "main" });
      const secondManager = requireManager(second);
      await secondManager.sync?.({ reason: "test" });
      const secondStatus = secondManager.status();
      expect(secondStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.files).toBe(
        1,
      );
      expect(
        secondStatus.sourceCounts?.find((entry) => entry.source === "sessions")?.chunks ?? 0,
      ).toBeGreaterThan(0);
      await secondManager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves unrelated dirty sessions after targeted post-compaction sync", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-dirty-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const firstSessionPath = path.join(sessionDir, "targeted-dirty-first.jsonl");
    const secondSessionPath = path.join(sessionDir, "targeted-dirty-second.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-dirty-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      firstSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "first transcript v1" }] },
      })}\n`,
    );
    await fs.writeFile(
      secondSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "second transcript v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
            };
          };
        }
      ).db;
      const getSessionHash = (sessionPath: string) =>
        db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionPath, "sessions")?.hash;

      const firstOriginalHash = getSessionHash("sessions/targeted-dirty-first.jsonl");
      const secondOriginalHash = getSessionHash("sessions/targeted-dirty-second.jsonl");

      await fs.writeFile(
        firstSessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "first transcript v2 after compaction" }],
          },
        })}\n`,
      );
      await fs.writeFile(
        secondSessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "second transcript v2 still pending" }],
          },
        })}\n`,
      );

      const internal = manager as unknown as {
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
      };
      internal.sessionsDirty = true;
      internal.sessionsDirtyFiles.add(secondSessionPath);

      await manager.sync({
        reason: "post-compaction",
        sessionFiles: [firstSessionPath],
      });

      expect(getSessionHash("sessions/targeted-dirty-first.jsonl")).not.toBe(firstOriginalHash);
      expect(getSessionHash("sessions/targeted-dirty-second.jsonl")).toBe(secondOriginalHash);
      expect(internal.sessionsDirtyFiles.has(secondSessionPath)).toBe(true);
      expect(internal.sessionsDirty).toBe(true);

      await manager.sync({ reason: "test" });

      expect(getSessionHash("sessions/targeted-dirty-second.jsonl")).not.toBe(secondOriginalHash);
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("surfaces failed targeted session refreshes and retries them later", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-retry-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, "targeted-retry.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-retry-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "retry transcript v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
            };
          };
        }
      ).db;
      const getSessionHash = (sessionRelPath: string) =>
        db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionRelPath, "sessions")?.hash;
      const originalHash = getSessionHash("sessions/targeted-retry.jsonl");

      await fs.writeFile(
        sessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "retry failure trigger after compaction" }],
          },
        })}\n`,
      );

      const internal = manager as unknown as {
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
        db: {
          prepare: (sql: string) => {
            run?: (...args: unknown[]) => unknown;
          };
        };
      };
      const originalPrepare = internal.db.prepare.bind(internal.db);
      internal.db.prepare = ((sql: string) => {
        const statement = originalPrepare(sql);
        if (sql.includes("INSERT INTO chunks") && statement.run) {
          const originalRun = statement.run.bind(statement);
          return {
            ...statement,
            run: (...args: unknown[]) => {
              if (args[1] === "sessions/targeted-retry.jsonl" && args[2] === "sessions") {
                throw new Error("session write failure");
              }
              return originalRun(...args);
            },
          };
        }
        return statement;
      }) as typeof internal.db.prepare;

      await expect(
        manager.sync({
          reason: "post-compaction",
          sessionFiles: [sessionPath],
        }),
      ).rejects.toThrow("session refresh failed");

      expect(getSessionHash("sessions/targeted-retry.jsonl")).toBe(originalHash);
      expect(internal.sessionsDirtyFiles.has(sessionPath)).toBe(true);
      expect(internal.sessionsDirty).toBe(true);

      internal.db.prepare = originalPrepare;
      await manager.sync({ reason: "test" });

      expect(getSessionHash("sessions/targeted-retry.jsonl")).not.toBe(originalHash);
      expect(internal.sessionsDirtyFiles.has(sessionPath)).toBe(false);
      expect(internal.sessionsDirty).toBe(false);
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("keeps the old session row when a renamed replacement fails during regular sync", async () => {
    const stateDir = path.join(fixtureRoot, `state-regular-rename-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const beforeSessionPath = path.join(sessionDir, "regular-rename-before.jsonl");
    const afterSessionPath = path.join(sessionDir, "regular-rename-after.jsonl");
    const deletedSessionPath = path.join(sessionDir, "regular-unrelated-deleted.jsonl");
    const storePath = path.join(workspaceDir, `index-regular-rename-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      beforeSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "rename transcript v1" }] },
      })}\n`,
    );
    await fs.writeFile(
      deletedSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "deleted transcript v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
            };
          };
        }
      ).db;
      const getSessionHash = (sessionRelPath: string) =>
        db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionRelPath, "sessions")?.hash;
      const originalHash = getSessionHash("sessions/regular-rename-before.jsonl");
      const deletedHash = getSessionHash("sessions/regular-unrelated-deleted.jsonl");
      expect(originalHash).toBeDefined();
      expect(deletedHash).toBeDefined();

      await fs.rename(beforeSessionPath, afterSessionPath);
      await fs.rm(deletedSessionPath, { force: true });
      await fs.writeFile(
        afterSessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "rename transcript v2 after failure" }],
          },
        })}\n`,
      );

      const internal = manager as unknown as {
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
      };
      const originalIndexFile = internal.indexFile.bind(manager);
      internal.indexFile = async (entry, options) => {
        if (options.source === "sessions" && entry.path === "sessions/regular-rename-after.jsonl") {
          throw new Error("session write failure");
        }
        await originalIndexFile(entry, options);
      };
      internal.sessionsDirty = true;
      internal.sessionsDirtyFiles.add(afterSessionPath);

      await expect(manager.sync({ reason: "test" })).resolves.toBeUndefined();

      expect(getSessionHash("sessions/regular-rename-before.jsonl")).toBe(originalHash);
      expect(getSessionHash("sessions/regular-rename-after.jsonl")).toBeUndefined();
      expect(getSessionHash("sessions/regular-unrelated-deleted.jsonl")).toBeUndefined();
      expect(internal.sessionsDirtyFiles.has(afterSessionPath)).toBe(true);
      expect(internal.sessionsDirty).toBe(true);

      internal.indexFile = originalIndexFile;
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("queues targeted session sync when another sync is already in progress", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-queued-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, "targeted-queued.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-queued-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "queued transcript v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
            };
          };
        }
      ).db;
      const getSessionHash = (sessionRelPath: string) =>
        db
          .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
          .get(sessionRelPath, "sessions")?.hash;
      const originalHash = getSessionHash("sessions/targeted-queued.jsonl");

      const internal = manager as unknown as {
        runSyncWithReadonlyRecovery: (params?: {
          reason?: string;
          sessionFiles?: string[];
        }) => Promise<void>;
      };
      const originalRunSync = internal.runSyncWithReadonlyRecovery.bind(manager);
      let releaseBusySync: (() => void) | undefined;
      const busyGate = new Promise<void>((resolve) => {
        releaseBusySync = resolve;
      });
      internal.runSyncWithReadonlyRecovery = async (params) => {
        if (params?.reason === "busy-sync") {
          await busyGate;
        }
        return await originalRunSync(params);
      };

      const busySyncPromise = manager.sync({ reason: "busy-sync" });
      await fs.writeFile(
        sessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "queued transcript v2 after compaction" }],
          },
        })}\n`,
      );

      const targetedSyncPromise = manager.sync({
        reason: "post-compaction",
        sessionFiles: [sessionPath],
      });

      releaseBusySync?.();
      await Promise.all([busySyncPromise, targetedSyncPromise]);

      expect(getSessionHash("sessions/targeted-queued.jsonl")).not.toBe(originalHash);
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("runs a full reindex after fallback activates during targeted sync", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-fallback-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, "targeted-fallback.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-fallback-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "fallback transcript v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const internal = manager as unknown as {
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
        activateFallbackProvider: (reason: string) => Promise<boolean>;
        runUnsafeReindex: (params: {
          reason?: string;
          force?: boolean;
          progress?: unknown;
        }) => Promise<void>;
      };
      const originalIndexFile = internal.indexFile.bind(manager);
      const originalActivateFallbackProvider = internal.activateFallbackProvider.bind(manager);
      const originalRunUnsafeReindex = internal.runUnsafeReindex.bind(manager);

      await fs.writeFile(
        sessionPath,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "fallback transcript v2" }],
          },
        })}\n`,
      );

      internal.indexFile = async (entry, options) => {
        if (options.source === "sessions" && entry.path === "sessions/targeted-fallback.jsonl") {
          throw new MemorySyncError({
            kind: "provider",
            message: "embedding backend failed",
          });
        }
        await originalIndexFile(entry, options);
      };
      const activateFallbackProvider = vi.fn(async () => true);
      internal.activateFallbackProvider = activateFallbackProvider;
      const runUnsafeReindex = vi.fn(async () => {});
      internal.runUnsafeReindex = runUnsafeReindex;

      await manager.sync({
        reason: "post-compaction",
        sessionFiles: [sessionPath],
      });

      expect(activateFallbackProvider).toHaveBeenCalledWith("embedding backend failed");
      expect(runUnsafeReindex).toHaveBeenCalledWith({
        reason: "post-compaction",
        force: true,
        progress: undefined,
      });

      internal.indexFile = originalIndexFile;
      internal.activateFallbackProvider = originalActivateFallbackProvider;
      internal.runUnsafeReindex = originalRunUnsafeReindex;
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("does not activate fallback for local embedding cache write failures", async () => {
    const memoryPath = path.join(memoryDir, "2026-01-15.md");
    await fs.writeFile(memoryPath, "# Cache\nAlpha cache v1.");

    const manager = await getPersistentManager(
      createCfg({
        storePath: path.join(workspaceDir, `index-cache-local-failure-${randomUUID()}.sqlite`),
        cacheEnabled: true,
        onSearch: false,
      }),
    );
    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => {
            get: (path: string, source: string) => { hash: string } | undefined;
            run?: (...args: unknown[]) => unknown;
          };
        };
      }
    ).db;
    const getMemoryHash = (filePath: string) =>
      db.prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`).get(filePath, "memory")
        ?.hash;

    await manager.sync({ reason: "seed" });
    const originalHash = getMemoryHash("memory/2026-01-15.md");
    expect(originalHash).toBeDefined();

    await fs.writeFile(memoryPath, "# Cache\nAlpha cache v2.");
    (manager as unknown as { dirty: boolean }).dirty = true;

    const internal = manager as unknown as {
      db: {
        prepare: (sql: string) => {
          run?: (...args: unknown[]) => unknown;
        };
      };
      activateFallbackProvider: (reason: string) => Promise<boolean>;
    };
    const originalPrepare = internal.db.prepare.bind(internal.db);
    const originalActivateFallbackProvider = internal.activateFallbackProvider.bind(manager);
    const activateFallbackProvider = vi.fn(async () => false);
    internal.activateFallbackProvider = activateFallbackProvider;
    internal.db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("INSERT INTO embedding_cache") && statement.run) {
        return {
          ...statement,
          run: (..._args: unknown[]) => {
            throw new Error("cache write failure");
          },
        };
      }
      return statement;
    }) as typeof internal.db.prepare;

    await expect(manager.sync({ reason: "test" })).resolves.toBeUndefined();
    expect(activateFallbackProvider).not.toHaveBeenCalled();
    expect(manager.status().dirty).toBe(true);
    expect(getMemoryHash("memory/2026-01-15.md")).toBe(originalHash);

    internal.db.prepare = originalPrepare;
    internal.activateFallbackProvider = originalActivateFallbackProvider;
  });

  it("rethrows readonly cache write failures during incremental sync", async () => {
    const memoryPath = path.join(memoryDir, "2026-01-16.md");
    await fs.writeFile(memoryPath, "# Cache\nAlpha readonly v1.");

    const manager = await getPersistentManager(
      createCfg({
        storePath: path.join(workspaceDir, `index-cache-readonly-${randomUUID()}.sqlite`),
        cacheEnabled: true,
        onSearch: false,
      }),
    );

    await manager.sync({ reason: "seed" });
    await fs.writeFile(memoryPath, "# Cache\nAlpha readonly v2.");

    const internal = manager as unknown as {
      dirty: boolean;
      db: {
        prepare: (sql: string) => {
          run?: (...args: unknown[]) => unknown;
        };
      };
      runSync: (params?: {
        reason?: string;
        force?: boolean;
        sessionFiles?: string[];
      }) => Promise<void>;
    };
    internal.dirty = true;

    const originalPrepare = internal.db.prepare.bind(internal.db);
    internal.db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("INSERT INTO embedding_cache") && statement.run) {
        return {
          ...statement,
          run: (..._args: unknown[]) => {
            throw new Error("attempt to write a readonly database");
          },
        };
      }
      return statement;
    }) as typeof internal.db.prepare;

    await expect(internal.runSync({ reason: "test" })).rejects.toThrow(
      "attempt to write a readonly database",
    );
    expect(manager.status().dirty).toBe(true);

    internal.db.prepare = originalPrepare;
  });

  it("stops targeted session refreshes after the first provider error", async () => {
    const stateDir = path.join(fixtureRoot, `state-targeted-stop-${randomUUID()}`);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const firstSessionPath = path.join(sessionDir, "targeted-stop-first.jsonl");
    const secondSessionPath = path.join(sessionDir, "targeted-stop-second.jsonl");
    const thirdSessionPath = path.join(sessionDir, "targeted-stop-third.jsonl");
    const storePath = path.join(workspaceDir, `index-targeted-stop-${randomUUID()}.sqlite`);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      firstSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "stop first v1" }] },
      })}\n`,
    );
    await fs.writeFile(
      secondSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "stop second v1" }] },
      })}\n`,
    );
    await fs.writeFile(
      thirdSessionPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "stop third v1" }] },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      await fs.writeFile(
        firstSessionPath,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "stop first v2" }] },
        })}\n`,
      );
      await fs.writeFile(
        secondSessionPath,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "stop second v2" }] },
        })}\n`,
      );
      await fs.writeFile(
        thirdSessionPath,
        `${JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "stop third v2" }] },
        })}\n`,
      );

      const internal = manager as unknown as {
        indexFile: (
          entry: { path: string },
          options: { source: "memory" | "sessions" },
        ) => Promise<void>;
        getIndexConcurrency: () => number;
      };
      const originalIndexFile = internal.indexFile.bind(manager);
      const originalGetIndexConcurrency = internal.getIndexConcurrency.bind(manager);
      const attemptedPaths: string[] = [];

      internal.getIndexConcurrency = () => 1;
      internal.indexFile = async (entry, options) => {
        if (options.source !== "sessions") {
          await originalIndexFile(entry, options);
          return;
        }
        attemptedPaths.push(entry.path);
        if (entry.path === "sessions/targeted-stop-first.jsonl") {
          throw new MemorySyncError({
            kind: "provider",
            message: "embedding backend failed",
          });
        }
        await originalIndexFile(entry, options);
      };

      await expect(
        manager.sync({
          reason: "post-compaction",
          sessionFiles: [firstSessionPath, secondSessionPath, thirdSessionPath],
        }),
      ).rejects.toMatchObject({
        kind: "provider",
        message: "embedding backend failed",
      });
      expect(attemptedPaths).toEqual(["sessions/targeted-stop-first.jsonl"]);

      internal.indexFile = originalIndexFile;
      internal.getIndexConcurrency = originalGetIndexConcurrency;
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it.each([
    {
      mode: "targeted",
      reason: "post-compaction",
      makeStateDir: () => path.join(fixtureRoot, `state-targeted-deleted-${randomUUID()}`),
      fileName: "targeted-deleted.jsonl",
      makeSyncArgs: (sessionPath: string) => ({
        reason: "post-compaction" as const,
        sessionFiles: [sessionPath],
      }),
    },
    {
      mode: "regular",
      reason: "test",
      makeStateDir: () => path.join(fixtureRoot, `state-regular-deleted-${randomUUID()}`),
      fileName: "regular-deleted.jsonl",
      makeSyncArgs: () => ({ reason: "test" as const }),
    },
  ])("clears deleted dirty session files during $mode sync", async (testCase) => {
    const stateDir = testCase.makeStateDir();
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const sessionPath = path.join(sessionDir, testCase.fileName);
    const sessionRelPath = `sessions/${testCase.fileName}`;
    const storePath = path.join(
      workspaceDir,
      `index-${testCase.mode}-deleted-${randomUUID()}.sqlite`,
    );
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `${testCase.mode} deleted transcript v1` }],
        },
      })}\n`,
    );

    try {
      const manager = requireManager(
        await getMemorySearchManager({
          cfg: createCfg({
            storePath,
            sources: ["sessions"],
            sessionMemory: true,
          }),
          agentId: "main",
        }),
      );
      await manager.sync({ reason: "test" });

      const db = (
        manager as unknown as {
          db: {
            prepare: (sql: string) => {
              get: (path: string, source: string) => { hash: string } | undefined;
            };
          };
        }
      ).db;
      const getSessionHash = (pathRel: string) =>
        db.prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`).get(pathRel, "sessions")
          ?.hash;
      expect(getSessionHash(sessionRelPath)).toBeDefined();

      await fs.rm(sessionPath, { force: true });

      const internal = manager as unknown as {
        sessionsDirty: boolean;
        sessionsDirtyFiles: Set<string>;
      };
      internal.sessionsDirty = true;
      internal.sessionsDirtyFiles.add(sessionPath);

      await manager.sync(testCase.makeSyncArgs(sessionPath));

      expect(getSessionHash(sessionRelPath)).toBeUndefined();
      expect(internal.sessionsDirtyFiles.has(sessionPath)).toBe(false);
      expect(internal.sessionsDirty).toBe(false);
      await manager.close?.();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(storePath, { force: true });
    }
  });

  it("reindexes when the embedding model changes", async () => {
    const base = createCfg({ storePath: indexModelPath });
    const baseAgents = base.agents!;
    const baseDefaults = baseAgents.defaults!;
    const baseMemorySearch = baseDefaults.memorySearch!;

    const first = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...baseAgents,
          defaults: {
            ...baseDefaults,
            memorySearch: {
              ...baseMemorySearch,
              model: "mock-embed-v1",
            },
          },
        },
      },
      agentId: "main",
    });
    const firstManager = requireManager(first);
    await firstManager.sync?.({ reason: "test" });
    const callsAfterFirstSync = embedBatchCalls;
    await firstManager.close?.();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...baseAgents,
          defaults: {
            ...baseDefaults,
            memorySearch: {
              ...baseMemorySearch,
              model: "mock-embed-v2",
            },
          },
        },
      },
      agentId: "main",
    });
    const secondManager = requireManager(second);
    await secondManager.sync?.({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(callsAfterFirstSync);
    const status = secondManager.status();
    expect(status.files).toBeGreaterThan(0);
    await secondManager.close?.();
  });

  it("passes Gemini outputDimensionality from config into the provider", async () => {
    const cfg = createCfg({
      storePath: indexMainPath,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 1536,
    });

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    await manager.probeEmbeddingAvailability();

    expect(
      providerCalls.some(
        (call) =>
          call.provider === "gemini" &&
          call.model === "gemini-embedding-2-preview" &&
          call.outputDimensionality === 1536,
      ),
    ).toBe(true);
    await manager.close?.();
  });

  it("does not initialize the provider when searching an empty index", async () => {
    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-empty-${randomUUID()}.sqlite`),
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 1536,
      onSearch: false,
    });

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);

    const results = await manager.search("hello");

    expect(results).toEqual([]);
    expect(providerCalls).toEqual([]);
    await manager.close?.();
  });

  it("snapshots builtin file hashes with a single sqlite query per sync", async () => {
    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "beta line\n");
    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-prepare-reuse-${randomUUID()}.sqlite`),
      onSearch: false,
    });

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);

    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
        };
      }
    ).db;
    const originalPrepare = db.prepare.bind(db);
    let selectSourceFileStatePrepareCalls = 0;
    let perFileHashPrepareCalls = 0;
    db.prepare = ((sql: string) => {
      if (sql === `SELECT path, hash, identity_key FROM files WHERE source = ?`) {
        selectSourceFileStatePrepareCalls += 1;
      }
      if (sql === `SELECT hash FROM files WHERE path = ? AND source = ?`) {
        perFileHashPrepareCalls += 1;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      await manager.sync({ reason: "test" });
    } finally {
      db.prepare = originalPrepare;
    }

    expect(selectSourceFileStatePrepareCalls).toBe(1);
    expect(perFileHashPrepareCalls).toBe(0);
  });

  it("uses a single sqlite aggregation query for status counts", async () => {
    const cfg = createCfg({
      storePath: path.join(workspaceDir, `index-status-aggregate-${randomUUID()}.sqlite`),
      sources: ["memory", "sessions"],
      sessionMemory: true,
      onSearch: false,
    });

    await fs.writeFile(path.join(memoryDir, "2026-01-13.md"), "beta line\n");

    const stateDir = path.join(fixtureRoot, `state-status-${randomUUID()}`);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "status.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "session status line" }] },
      }) + "\n",
    );

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    const manager = requireManager(result);
    managersForCleanup.add(manager);
    await manager.sync({ reason: "test" });

    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => { all: (...args: unknown[]) => unknown };
        };
      }
    ).db;
    const originalPrepare = db.prepare.bind(db);
    let aggregatePrepareCalls = 0;
    let legacyCountPrepareCalls = 0;
    db.prepare = ((sql: string) => {
      if (
        sql.includes(`SELECT 'files' AS kind, source, COUNT(*) as c FROM files`) &&
        sql.includes(`UNION ALL`)
      ) {
        aggregatePrepareCalls += 1;
      }
      if (
        sql === `SELECT COUNT(*) as c FROM files WHERE 1=1` ||
        sql === `SELECT COUNT(*) as c FROM chunks WHERE 1=1` ||
        sql === `SELECT source, COUNT(*) as c FROM files WHERE 1=1 GROUP BY source` ||
        sql === `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1 GROUP BY source`
      ) {
        legacyCountPrepareCalls += 1;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      const status = manager.status();
      expect(status.files).toBeGreaterThan(0);
      expect(status.chunks).toBeGreaterThan(0);
      expect(
        status.sourceCounts?.find((entry) => entry.source === "memory")?.files,
      ).toBeGreaterThan(0);
      expect(
        status.sourceCounts?.find((entry) => entry.source === "sessions")?.files,
      ).toBeGreaterThan(0);
    } finally {
      db.prepare = originalPrepare;
      vi.unstubAllEnvs();
    }

    expect(aggregatePrepareCalls).toBe(1);
    expect(legacyCountPrepareCalls).toBe(0);
  });

  it("reindexes when Gemini outputDimensionality changes", async () => {
    const base = createCfg({
      storePath: indexModelPath,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      outputDimensionality: 3072,
    });
    const baseAgents = base.agents!;
    const baseDefaults = baseAgents.defaults!;
    const baseMemorySearch = baseDefaults.memorySearch!;

    const first = await getMemorySearchManager({ cfg: base, agentId: "main" });
    const firstManager = requireManager(first);
    await firstManager.sync?.({ reason: "test" });
    const callsAfterFirstSync = embedBatchCalls;
    await firstManager.close?.();

    const second = await getMemorySearchManager({
      cfg: {
        ...base,
        agents: {
          ...baseAgents,
          defaults: {
            ...baseDefaults,
            memorySearch: {
              ...baseMemorySearch,
              outputDimensionality: 768,
            },
          },
        },
      },
      agentId: "main",
    });
    const secondManager = requireManager(second);
    await secondManager.sync?.({ reason: "test" });
    expect(embedBatchCalls).toBeGreaterThan(callsAfterFirstSync);
    await secondManager.close?.();
  });

  it("reindexes when extraPaths change", async () => {
    const storePath = path.join(workspaceDir, `index-scope-extra-${randomUUID()}.sqlite`);
    const firstExtraDir = path.join(workspaceDir, "scope-extra-a");
    const secondExtraDir = path.join(workspaceDir, "scope-extra-b");
    await fs.rm(firstExtraDir, { recursive: true, force: true });
    await fs.rm(secondExtraDir, { recursive: true, force: true });
    await fs.mkdir(firstExtraDir, { recursive: true });
    await fs.mkdir(secondExtraDir, { recursive: true });
    await fs.writeFile(path.join(firstExtraDir, "a.md"), "alpha only");
    await fs.writeFile(path.join(secondExtraDir, "b.md"), "beta only");

    const first = await getMemorySearchManager({
      cfg: createCfg({
        storePath,
        extraPaths: [firstExtraDir],
      }),
      agentId: "main",
    });
    const firstManager = requireManager(first);
    await firstManager.sync?.({ reason: "test" });
    await firstManager.close?.();

    const second = await getMemorySearchManager({
      cfg: createCfg({
        storePath,
        extraPaths: [secondExtraDir],
      }),
      agentId: "main",
    });
    const secondManager = requireManager(second);
    await secondManager.sync?.({ reason: "test" });
    const results = await secondManager.search("beta");
    expect(results.some((result) => result.path.endsWith("scope-extra-b/b.md"))).toBe(true);
    expect(results.some((result) => result.path.endsWith("scope-extra-a/a.md"))).toBe(false);
    await secondManager.close?.();
  });

  it("reindexes when multimodal settings change", async () => {
    const storePath = path.join(workspaceDir, `index-scope-multimodal-${randomUUID()}.sqlite`);
    const mediaDir = path.join(workspaceDir, "scope-media");
    await fs.rm(mediaDir, { recursive: true, force: true });
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));

    const first = await getMemorySearchManager({
      cfg: createCfg({
        storePath,
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        extraPaths: [mediaDir],
      }),
      agentId: "main",
    });
    const firstManager = requireManager(first);
    await firstManager.sync?.({ reason: "test" });
    const multimodalCallsAfterFirstSync = embedBatchInputCalls;
    await firstManager.close?.();

    const second = await getMemorySearchManager({
      cfg: createCfg({
        storePath,
        provider: "gemini",
        model: "gemini-embedding-2-preview",
        extraPaths: [mediaDir],
        multimodal: { enabled: true, modalities: ["image"] },
      }),
      agentId: "main",
    });
    const secondManager = requireManager(second);
    await secondManager.sync?.({ reason: "test" });
    expect(embedBatchInputCalls).toBeGreaterThan(multimodalCallsAfterFirstSync);
    const results = await secondManager.search("image");
    expect(results.some((result) => result.path.endsWith("scope-media/diagram.png"))).toBe(true);
    await secondManager.close?.();
  });

  it("reuses cached embeddings on forced reindex", async () => {
    const cfg = createCfg({ storePath: indexMainPath, cacheEnabled: true });
    const manager = await getPersistentManager(cfg);
    // Seed the embedding cache once, then ensure a forced reindex doesn't
    // re-embed when the cache is enabled.
    await manager.sync({ reason: "test" });
    const afterFirst = embedBatchCalls;
    expect(afterFirst).toBeGreaterThan(0);

    await manager.sync({ force: true });
    expect(embedBatchCalls).toBe(afterFirst);
  });

  it("keeps failed memory files dirty for a later retry", async () => {
    const memoryPath = path.join(memoryDir, "2026-01-13.md");
    const stalePath = path.join(memoryDir, "same-path-unrelated-stale.md");
    await fs.writeFile(memoryPath, "# Bad\nGamma v1.");
    await fs.writeFile(stalePath, "# Deleted\nThis unrelated stale note should be pruned.");

    const manager = await getPersistentManager(
      createCfg({
        storePath: path.join(workspaceDir, `index-skip-failure-${randomUUID()}.sqlite`),
        onSearch: false,
      }),
    );
    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => {
            get: (path: string, source: string) => { hash: string } | undefined;
          };
        };
      }
    ).db;
    const getMemoryHash = (memoryPath: string) =>
      db.prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`).get(memoryPath, "memory")
        ?.hash;
    const listMemoryPaths = () =>
      (
        db.prepare(`SELECT path FROM files WHERE source = ? ORDER BY path`) as unknown as {
          all: (source: string) => Array<{ path: string }>;
        }
      )
        .all("memory")
        .map((row) => row.path);

    await manager.sync({ reason: "seed" });
    const originalHash = getMemoryHash("memory/2026-01-13.md");
    expect(originalHash).toBeDefined();
    expect(listMemoryPaths()).toContain("memory/same-path-unrelated-stale.md");
    await fs.writeFile(memoryPath, "# Bad\nGamma failure trigger.");
    await fs.rm(stalePath, { force: true });
    (manager as unknown as { dirty: boolean }).dirty = true;

    const internal = manager as unknown as {
      db: {
        prepare: (sql: string) => {
          run?: (...args: unknown[]) => unknown;
        };
      };
    };
    const originalPrepare = internal.db.prepare.bind(internal.db);
    internal.db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (sql.includes("INSERT INTO chunks") && statement.run) {
        const originalRun = statement.run.bind(statement);
        return {
          ...statement,
          run: (...args: unknown[]) => {
            if (args[1] === "memory/2026-01-13.md" && args[2] === "memory") {
              throw new Error("file write failure");
            }
            return originalRun(...args);
          },
        };
      }
      return statement;
    }) as typeof internal.db.prepare;

    await expect(manager.sync({ reason: "test" })).resolves.toBeUndefined();
    expect(manager.status().dirty).toBe(true);
    expect(getMemoryHash("memory/2026-01-13.md")).toBe(originalHash);
    expect(listMemoryPaths()).not.toContain("memory/same-path-unrelated-stale.md");

    internal.db.prepare = originalPrepare;
    await manager.sync({ reason: "retry" });

    expect(manager.status().dirty).toBe(false);
    expect(getMemoryHash("memory/2026-01-13.md")).not.toBe(originalHash);
  });

  it("keeps the old memory row when a renamed replacement fails to index", async () => {
    await fs.writeFile(
      path.join(memoryDir, "unrelated-stale.md"),
      "# Deleted\nThis stale note should be pruned.",
    );
    const manager = await getPersistentManager(
      createCfg({
        storePath: path.join(workspaceDir, `index-rename-retry-${randomUUID()}.sqlite`),
        onSearch: false,
      }),
    );
    const db = (
      manager as unknown as {
        db: {
          prepare: (sql: string) => {
            all: (source: string) => Array<{ path: string }>;
          };
        };
      }
    ).db;
    const listMemoryPaths = () =>
      db
        .prepare(`SELECT path FROM files WHERE source = ? ORDER BY path`)
        .all("memory")
        .map((row) => row.path);

    await manager.sync({ reason: "seed" });
    expect(listMemoryPaths()).toContain("memory/2026-01-12.md");
    expect(listMemoryPaths()).toContain("memory/unrelated-stale.md");

    await fs.rename(path.join(memoryDir, "2026-01-12.md"), path.join(memoryDir, "2026-01-14.md"));
    await fs.rm(path.join(memoryDir, "unrelated-stale.md"), { force: true });
    await fs.writeFile(
      path.join(memoryDir, "2026-01-14.md"),
      "# Log\nAlpha memory line.\nZebra memory line.",
    );
    (manager as unknown as { dirty: boolean }).dirty = true;

    const internal = manager as unknown as {
      indexFile: (
        entry: { path: string },
        options: { source: "memory" | "sessions" },
      ) => Promise<void>;
    };
    const originalIndexFile = internal.indexFile.bind(manager);
    internal.indexFile = async (entry, options) => {
      if (options.source === "memory" && entry.path === "memory/2026-01-14.md") {
        throw new Error("replacement write failed");
      }
      await originalIndexFile(entry, options);
    };

    await expect(manager.sync({ reason: "test" })).resolves.toBeUndefined();

    expect(listMemoryPaths()).toContain("memory/2026-01-12.md");
    expect(listMemoryPaths()).not.toContain("memory/2026-01-14.md");
    expect(listMemoryPaths()).not.toContain("memory/unrelated-stale.md");
    expect(manager.status().dirty).toBe(true);

    internal.indexFile = originalIndexFile;
    await manager.close?.();
  });

  it.skip("finds keyword matches via hybrid search when query embedding is zero", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        storePath: indexMainPath,
        hybrid: { enabled: true, vectorWeight: 0, textWeight: 1 },
      }),
    );
  });

  it.skip("preserves keyword-only hybrid hits when minScore exceeds text weight", async () => {
    await expectHybridKeywordSearchFindsMemory(
      createCfg({
        storePath: indexMainPath,
        minScore: 0.35,
        hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      }),
    );
  });

  it("reports vector availability after probe", async () => {
    const cfg = createCfg({ storePath: indexVectorPath, vectorEnabled: true });
    const manager = await getPersistentManager(cfg);
    const available = await manager.probeVectorAvailability();
    const status = manager.status();
    expect(status.vector?.enabled).toBe(true);
    expect(typeof status.vector?.available).toBe("boolean");
    expect(status.vector?.available).toBe(available);
  });

  it("rejects reading non-memory paths", async () => {
    const cfg = createCfg({ storePath: indexMainPath });
    const manager = await getPersistentManager(cfg);
    await expect(manager.readFile({ relPath: "NOTES.md" })).rejects.toThrow("path required");
  });

  it("allows reading from additional memory paths and blocks symlinks", async () => {
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "extra.md"), "Extra content.");

    const cfg = createCfg({ storePath: indexExtraPath, extraPaths: [extraDir] });
    const manager = await getPersistentManager(cfg);
    await expect(manager.readFile({ relPath: "extra/extra.md" })).resolves.toEqual({
      path: "extra/extra.md",
      text: "Extra content.",
    });

    const linkPath = path.join(extraDir, "linked.md");
    let symlinkOk = true;
    try {
      await fs.symlink(path.join(extraDir, "extra.md"), linkPath, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinkOk = false;
      } else {
        throw err;
      }
    }
    if (symlinkOk) {
      await expect(manager.readFile({ relPath: "extra/linked.md" })).rejects.toThrow(
        "path required",
      );
    }
  });
});
