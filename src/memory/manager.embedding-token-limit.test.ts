import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./embedding.test-mocks.js";
import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";

const embedBatch = getEmbedBatchMock();

describe("memory embedding token limits", () => {
  let fixtureRoot: string;
  let workspaceDir: string;
  let memoryDir: string;
  let indexPathLarge: string;
  let indexPathSmall: string;
  let managerLarge: MemoryIndexManager | null = null;
  let managerSmall: MemoryIndexManager | null = null;

  function createCfg(params: { indexPath: string; tokens: number }) {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: params.indexPath, vector: { enabled: false } },
            chunking: { tokens: params.tokens, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0 },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-token-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    indexPathLarge = path.join(fixtureRoot, "index.large.sqlite");
    indexPathSmall = path.join(fixtureRoot, "index.small.sqlite");
    await fs.mkdir(memoryDir, { recursive: true });

    const large = await getMemorySearchManager({
      cfg: createCfg({ indexPath: indexPathLarge, tokens: 10_000 }),
      agentId: "main",
    });
    expect(large.manager).not.toBeNull();
    if (!large.manager) {
      throw new Error("manager missing");
    }
    managerLarge = large.manager;

    const small = await getMemorySearchManager({
      cfg: createCfg({ indexPath: indexPathSmall, tokens: 1000 }),
      agentId: "main",
    });
    expect(small.manager).not.toBeNull();
    if (!small.manager) {
      throw new Error("manager missing");
    }
    managerSmall = small.manager;
  });

  afterAll(async () => {
    if (managerLarge) {
      await managerLarge.close();
      managerLarge = null;
    }
    if (managerSmall) {
      await managerSmall.close();
      managerSmall = null;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetEmbeddingMocks();

    await fs.rm(memoryDir, { recursive: true, force: true });
    await fs.mkdir(memoryDir, { recursive: true });

    const reset = (manager: MemoryIndexManager | null) => {
      if (!manager) {
        throw new Error("manager missing");
      }
      (manager as unknown as { resetIndex: () => void }).resetIndex();
      (manager as unknown as { dirty: boolean }).dirty = true;
    };
    reset(managerLarge);
    reset(managerSmall);
  });

  it("splits oversized chunks so each embedding input stays <= 8192 UTF-8 bytes", async () => {
    const content = "x".repeat(9500);
    await fs.writeFile(path.join(memoryDir, "2026-01-09.md"), content);
    if (!managerLarge) {
      throw new Error("manager missing");
    }
    await managerLarge.sync({ reason: "test" });

    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      Math.max(...inputs.map((input) => Buffer.byteLength(input, "utf8"))),
    ).toBeLessThanOrEqual(8192);
  });

  it("uses UTF-8 byte estimates when batching multibyte chunks", async () => {
    const line = "😀".repeat(1800);
    const content = `${line}\n${line}\n${line}`;
    await fs.writeFile(path.join(memoryDir, "2026-01-10.md"), content);
    if (!managerSmall) {
      throw new Error("manager missing");
    }
    await managerSmall.sync({ reason: "test" });

    const batchSizes = embedBatch.mock.calls.map(
      (call) => (call[0] as string[] | undefined)?.length ?? 0,
    );
    expect(batchSizes.length).toBe(3);
    expect(batchSizes.every((size) => size === 1)).toBe(true);
    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs.every((input) => Buffer.byteLength(input, "utf8") <= 8192)).toBe(true);
  });
});
