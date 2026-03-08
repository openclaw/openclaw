import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGroupMetadataProvider,
  getGroupMetadata,
  listGroups,
  searchGroups,
  setGroupMetadataProvider,
} from "./group-metadata.js";

const makeProvider = (
  data: Record<string, { subject?: string; isCommunity?: boolean; linkedParent?: string }>,
) => ({
  groupFetchAllParticipating: vi.fn().mockResolvedValue(data),
});

afterEach(() => {
  clearGroupMetadataProvider();
});

describe("group-metadata", () => {
  it("returns empty map when no provider registered", async () => {
    const groups = await listGroups();
    expect(groups.size).toBe(0);
  });

  it("getGroupMetadata returns null when no provider registered", async () => {
    const result = await getGroupMetadata("123@g.us");
    expect(result).toBeNull();
  });

  it("lists groups from provider", async () => {
    const provider = makeProvider({
      "111@g.us": { subject: "Family", isCommunity: false },
      "222@g.us": { subject: "Work", isCommunity: true, linkedParent: "333@g.us" },
    });
    setGroupMetadataProvider(provider);

    const groups = await listGroups();
    expect(groups.size).toBe(2);
    expect(groups.get("111@g.us")).toEqual({
      subject: "Family",
      isCommunity: false,
      linkedParent: undefined,
    });
    expect(groups.get("222@g.us")).toEqual({
      subject: "Work",
      isCommunity: true,
      linkedParent: "333@g.us",
    });
  });

  it("caches data on second call", async () => {
    const provider = makeProvider({
      "111@g.us": { subject: "Family" },
    });
    setGroupMetadataProvider(provider);

    await listGroups();
    await listGroups();
    expect(provider.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const provider = makeProvider({
      "111@g.us": { subject: "Family" },
    });
    setGroupMetadataProvider(provider);

    await listGroups();
    expect(provider.groupFetchAllParticipating).toHaveBeenCalledTimes(1);

    // Advance time past TTL (5 minutes)
    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await listGroups();
    expect(provider.groupFetchAllParticipating).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("getGroupMetadata returns entry for known jid", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": { subject: "Family", isCommunity: false },
      }),
    );

    const meta = await getGroupMetadata("111@g.us");
    expect(meta).toEqual({
      subject: "Family",
      isCommunity: false,
      linkedParent: undefined,
    });
  });

  it("getGroupMetadata returns null for unknown jid", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": { subject: "Family" },
      }),
    );

    const meta = await getGroupMetadata("999@g.us");
    expect(meta).toBeNull();
  });

  it("searchGroups matches by subject", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": { subject: "Family Chat" },
        "222@g.us": { subject: "Work Team" },
        "333@g.us": { subject: "Family Photos" },
      }),
    );

    const results = await searchGroups("family");
    expect(results.size).toBe(2);
    expect(results.has("111@g.us")).toBe(true);
    expect(results.has("333@g.us")).toBe(true);
  });

  it("searchGroups matches by jid", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": { subject: "Group A" },
        "222@g.us": { subject: "Group B" },
      }),
    );

    const results = await searchGroups("222");
    expect(results.size).toBe(1);
    expect(results.has("222@g.us")).toBe(true);
  });

  it("searchGroups returns empty for no matches", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": { subject: "Family" },
      }),
    );

    const results = await searchGroups("nonexistent");
    expect(results.size).toBe(0);
  });

  it("clearGroupMetadataProvider clears cache", async () => {
    const provider = makeProvider({
      "111@g.us": { subject: "Family" },
    });
    setGroupMetadataProvider(provider);

    await listGroups();
    clearGroupMetadataProvider();

    const groups = await listGroups();
    expect(groups.size).toBe(0);
  });

  it("defaults subject to jid when missing", async () => {
    setGroupMetadataProvider(
      makeProvider({
        "111@g.us": {},
      }),
    );

    const meta = await getGroupMetadata("111@g.us");
    expect(meta?.subject).toBe("111@g.us");
  });
});
