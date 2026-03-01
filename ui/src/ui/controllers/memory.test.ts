import { describe, expect, it, vi } from "vitest";
import { loadMemoryStatus, type MemoryState, type MemoryStatusResult } from "./memory.ts";

function createState(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    client: null,
    connected: false,
    memoryLoading: false,
    memoryStatus: null,
    memoryError: null,
    ...overrides,
  };
}

function createMockClient(response: MemoryStatusResult | undefined = undefined) {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

describe("loadMemoryStatus", () => {
  it("does nothing when client is null", async () => {
    const state = createState();
    await loadMemoryStatus(state);
    expect(state.memoryLoading).toBe(false);
    expect(state.memoryStatus).toBeNull();
  });

  it("does nothing when not connected", async () => {
    const client = createMockClient();
    const state = createState({ client: client as never, connected: false });
    await loadMemoryStatus(state);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does nothing when already loading", async () => {
    const client = createMockClient();
    const state = createState({ client: client as never, connected: true, memoryLoading: true });
    await loadMemoryStatus(state);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("loads memory status successfully", async () => {
    const result: MemoryStatusResult = {
      agentId: "main",
      status: {
        backend: "builtin",
        provider: "local",
        files: 3,
        chunks: 12,
        dirty: false,
        fts: { enabled: true, available: true },
        vector: { enabled: true, available: true, dims: 256 },
        cache: { enabled: true, entries: 10 },
      },
    };
    const client = createMockClient(result);
    const state = createState({ client: client as never, connected: true });

    await loadMemoryStatus(state);

    expect(client.request).toHaveBeenCalledWith("memory.status", {});
    expect(state.memoryStatus).toEqual(result);
    expect(state.memoryError).toBeNull();
    expect(state.memoryLoading).toBe(false);
  });

  it("sets error from response", async () => {
    const result: MemoryStatusResult = {
      agentId: "main",
      status: null,
      error: "memory search unavailable",
    };
    const client = createMockClient(result);
    const state = createState({ client: client as never, connected: true });

    await loadMemoryStatus(state);

    expect(state.memoryStatus).toEqual(result);
    expect(state.memoryError).toBe("memory search unavailable");
  });

  it("handles request failure", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error("connection lost")),
    };
    const state = createState({ client: client as never, connected: true });

    await loadMemoryStatus(state);

    expect(state.memoryError).toBe("connection lost");
    expect(state.memoryLoading).toBe(false);
  });
});
