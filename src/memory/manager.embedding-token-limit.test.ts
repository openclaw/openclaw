import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installEmbeddingManagerFixture } from "./embedding-manager.test-harness.js";

const fx = installEmbeddingManagerFixture({
  fixturePrefix: "openclaw-mem-token-",
  largeTokens: 10_000,
  smallTokens: 1000,
  createCfg: ({ workspaceDir, indexPath, tokens }) => ({
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          chunking: { tokens, overlap: 0 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0 },
        },
      },
      list: [{ id: "main", default: true }],
    },
  }),
});
const { embedBatch } = fx;

describe("memory embedding token limits", () => {
  it("splits oversized chunks so each embedding input stays <= 8192 UTF-8 bytes", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerLarge = fx.getManagerLarge();
    const content = "x".repeat(9500);
    await fs.writeFile(path.join(memoryDir, "2026-01-09.md"), content);
    await managerLarge.sync({ reason: "test" });

    const inputs = embedBatch.mock.calls.flatMap((call) => call[0] ?? []);
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      Math.max(...inputs.map((input) => Buffer.byteLength(input, "utf8"))),
    ).toBeLessThanOrEqual(8192);
  });

  it("uses UTF-8 byte estimates when batching multibyte chunks", async () => {
    const memoryDir = fx.getMemoryDir();
    const managerSmall = fx.getManagerSmall();
    const line = "😀".repeat(1800);
    const content = `${line}\n${line}\n${line}`;
    await fs.writeFile(path.join(memoryDir, "2026-01-10.md"), content);
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
