import { describe, expect, it, vi, beforeEach } from "vitest";

const mockFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: async (p: string) => {
      if (!mockFiles.has(p)) {
        throw new Error("ENOENT");
      }
      return mockFiles.get(p) ?? "";
    },
    writeFile: async (p: string, content: string) => {
      mockFiles.set(p, content);
    },
    rename: async (src: string, dest: string) => {
      const content = mockFiles.get(src);
      if (content !== undefined) {
        mockFiles.set(dest, content);
        mockFiles.delete(src);
      }
    },
    readdir: async () => [],
  },
}));

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/delivery-test",
}));

const { addToIndex, removeFromIndex, queryIndex, getIndexSize } =
  await import("./delivery-index.js");

describe("delivery-index", () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  it("adds and queries entries", async () => {
    await addToIndex({
      id: "d1",
      channel: "telegram",
      accountId: "default",
      enqueuedAt: 1000,
      lanePriority: "user-visible",
    });
    await addToIndex({
      id: "d2",
      channel: "discord",
      accountId: "bot1",
      enqueuedAt: 2000,
      lanePriority: "user-visible",
    });
    expect(await getIndexSize()).toBe(2);
    const telegramEntries = await queryIndex({ channel: "telegram" });
    expect(telegramEntries).toHaveLength(1);
    expect(telegramEntries[0].id).toBe("d1");
  });

  it("removes entries", async () => {
    await addToIndex({
      id: "d1",
      channel: "telegram",
      enqueuedAt: 1000,
      lanePriority: "user-visible",
    });
    await removeFromIndex("d1");
    expect(await getIndexSize()).toBe(0);
  });

  it("filters by channel and accountId", async () => {
    await addToIndex({
      id: "d1",
      channel: "telegram",
      accountId: "default",
      enqueuedAt: 1000,
      lanePriority: "user-visible",
    });
    await addToIndex({
      id: "d2",
      channel: "telegram",
      accountId: "bot2",
      enqueuedAt: 2000,
      lanePriority: "user-visible",
    });
    await addToIndex({
      id: "d3",
      channel: "discord",
      accountId: "default",
      enqueuedAt: 3000,
      lanePriority: "user-visible",
    });
    const filtered = await queryIndex({ channel: "telegram", accountId: "default" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("d1");
  });

  it("returns entries sorted by enqueuedAt", async () => {
    await addToIndex({
      id: "d2",
      channel: "telegram",
      enqueuedAt: 2000,
      lanePriority: "user-visible",
    });
    await addToIndex({
      id: "d1",
      channel: "telegram",
      enqueuedAt: 1000,
      lanePriority: "user-visible",
    });
    const all = await queryIndex();
    expect(all[0].id).toBe("d1");
    expect(all[1].id).toBe("d2");
  });

  it("handles missing index file gracefully", async () => {
    expect(await getIndexSize()).toBe(0);
    expect(await queryIndex()).toEqual([]);
  });
});
