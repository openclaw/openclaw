import { describe, expect, it } from "vitest";
import { resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared.js";

function collapsePrefixToWildcard(entry: string): string | undefined {
  const trimmed = entry
    .trim()
    .replace(/^(demo|user):/i, "")
    .trim();
  return trimmed || undefined;
}

function rejectWildcard(entry: string): string | undefined {
  const trimmed = entry.trim();
  if (!trimmed || trimmed === "*") {
    return undefined;
  }
  return trimmed.replace(/^user:/i, "").trim() || undefined;
}

function pin(
  allowFrom: string[],
  normalizeEntry: (entry: string) => string | undefined,
): string | null {
  return resolvePinnedMainDmOwnerFromAllowlist({ dmScope: "main", allowFrom, normalizeEntry });
}

describe("resolvePinnedMainDmOwnerFromAllowlist", () => {
  it.each(["demo:*", "user:*", "  demo:*  "])(
    "leaves %s unpinned when the channel normalizer resolves it to a wildcard",
    (entry) => {
      expect(collapsePrefixToWildcard(entry)).toBe("*");
      expect(pin([entry], collapsePrefixToWildcard)).toBeNull();
    },
  );

  it("keeps a raw wildcard unpinned for normalizers that reject it", () => {
    expect(rejectWildcard("*")).toBeUndefined();
    expect(pin(["*"], rejectWildcard)).toBeNull();
    expect(pin(["*"], collapsePrefixToWildcard)).toBeNull();
  });

  it("keeps a prefixed wildcard unpinned next to a named owner", () => {
    expect(pin(["demo:*", "demo:owner-1"], collapsePrefixToWildcard)).toBeNull();
  });

  it("still pins a single normalized owner", () => {
    expect(pin(["demo:owner-1"], collapsePrefixToWildcard)).toBe("owner-1");
    expect(pin(["user:owner-1"], rejectWildcard)).toBe("owner-1");
    expect(pin(["demo:owner-1", "demo:owner-2"], collapsePrefixToWildcard)).toBeNull();
  });
});
