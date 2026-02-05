import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrimary = {
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() => ({
    backend: "qmd" as const,
    provider: "qmd",
    model: "qmd",
    requestedProvider: "qmd",
    files: 0,
    chunks: 0,
    dirty: false,
    workspaceDir: "/tmp",
    dbPath: "/tmp/index.sqlite",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 0, chunks: 0 }],
  })),
  sync: vi.fn(async () => {}),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => {}),
};

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("./manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(async () => null),
  },
}));

import { MemoryIndexManager } from "./manager.js";
import { QmdMemoryManager } from "./qmd-manager.js";
import { getMemorySearchManager } from "./search-manager.js";

beforeEach(() => {
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(QmdMemoryManager.create).mockClear();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(MemoryIndexManager.get).mockClear();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  vi.mocked(MemoryIndexManager.get).mockResolvedValue(null);
});

describe("getMemorySearchManager caching", () => {
  it("reuses the same QMD manager instance for repeated calls", async () => {
    const agentId = "agent-cache-test-1";
    const cfg = {
      memory: { backend: "qmd", qmd: {} },
      agents: { list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }] },
    } as const;

    const first = await getMemorySearchManager({ cfg, agentId });
    const second = await getMemorySearchManager({ cfg, agentId });

    expect(first.manager).toBe(second.manager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(QmdMemoryManager.create).toHaveBeenCalledTimes(1);
  });

  it("handles fallback errors gracefully when QMD fails and builtin requires auth", async () => {
    // Use unique agent ID to avoid cache interference from other tests
    const agentId = "agent-fallback-test-1";
    const cfg = {
      memory: { backend: "qmd", qmd: {} },
      agents: { list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }] },
    } as const;

    // Mock QMD primary to fail on search
    mockPrimary.search.mockRejectedValueOnce(new Error("QMD search failed"));

    // Mock builtin index to fail due to missing auth (simulating no OpenAI key)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(MemoryIndexManager.get).mockRejectedValueOnce(
      new Error("No API key found for provider: openai"),
    );

    const result = await getMemorySearchManager({ cfg, agentId });
    expect(result.manager).toBeTruthy();

    // First search should try QMD and fail
    // Then try to create fallback, which also fails
    // Should throw with the QMD error since fallback is unavailable
    await expect(result.manager!.search("test query")).rejects.toThrow("QMD search failed");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(MemoryIndexManager.get).toHaveBeenCalledTimes(1);
  });
});
