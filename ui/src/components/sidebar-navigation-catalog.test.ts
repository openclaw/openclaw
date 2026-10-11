import { describe, expect, it } from "vitest";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { navigationScopesEquivalent } from "./app-sidebar-session-navigation-logic.ts";

function snapshot(
  totalCount: number,
  counts: { profileId: string; open: number; running: number }[],
): SessionListSnapshot {
  return {
    result: {
      ...sessionsResult([{ key: "agent:main:one", kind: "direct", updatedAt: 1 }], 1),
      totalCount,
      hasMore: totalCount > 1,
      ownerSessionCounts: counts,
    },
    loading: false,
    error: null,
    agentId: null,
  };
}

describe("navigation scope equivalence", () => {
  it("uses complete count metadata rather than loaded rows or online presence", () => {
    const onlySelf = [{ profileId: "self", open: 100, running: 0 }];
    expect(navigationScopesEquivalent(snapshot(100, onlySelf), "self")).toBe(true);
    expect(navigationScopesEquivalent(snapshot(101, onlySelf), "self")).toBe(false);
    expect(
      navigationScopesEquivalent(
        snapshot(100, [
          { profileId: "self", open: 99, running: 0 },
          { profileId: "offline", open: 1, running: 0 },
        ]),
        "self",
      ),
    ).toBe(false);
  });
  it("does not collapse unknown, loading, failed, or ownerless summaries", () => {
    const known = snapshot(1, [{ profileId: "self", open: 1, running: 0 }]);
    expect(navigationScopesEquivalent(undefined, "self")).toBe(false);
    expect(navigationScopesEquivalent({ ...known, loading: true }, "self")).toBe(false);
    expect(navigationScopesEquivalent({ ...known, error: "offline" }, "self")).toBe(false);
    expect(navigationScopesEquivalent({ ...known, startupPending: true }, "self")).toBe(false);
    expect(navigationScopesEquivalent({ ...known, readSucceeded: false }, "self")).toBe(false);
    expect(navigationScopesEquivalent(snapshot(1, []), "self")).toBe(false);
    expect(
      navigationScopesEquivalent(
        { ...known, result: { ...known.result!, ownerSessionCounts: undefined } },
        "self",
      ),
    ).toBe(false);
  });
});
