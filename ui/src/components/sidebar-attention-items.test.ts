import { describe, expect, it } from "vitest";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  sidebarInboxTabCounts,
} from "./sidebar-attention-entries.ts";
import { buildSidebarAttentionEntries } from "./sidebar-attention-items.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";

function accountWarning(arrivedAtMs: number) {
  return buildSidebarAttentionEntries({
    modelAuthStatus: {
      ts: arrivedAtMs,
      providers: [{ provider: "openai", displayName: "OpenAI", status: "missing", profiles: [] }],
    },
    now: arrivedAtMs,
  });
}

function inbox(
  requiresAction: boolean,
  overrides: Partial<Parameters<typeof buildSidebarInboxEntries>[0]> = {},
) {
  return buildSidebarInboxEntries({
    approvals: [],
    attention: [],
    mentions: [],
    scopeUpgrade: null,
    update: {
      type: "update",
      category: "system",
      dismissal: null,
      requiresAction,
      severity: "warning",
    },
    ...overrides,
  });
}

describe("sidebar attention projection", () => {
  it("orders rows by arrival, newest first, with timeless live states on top", () => {
    const entries = buildSidebarInboxEntries({
      approvals: [
        { id: "old", createdAtMs: 1_000 },
        { id: "new", createdAtMs: 4_000 },
      ] as never,
      attention: accountWarning(2_000),
      mentions: [{ ...inboxMention("mention"), createdAt: 3_000 }],
      scopeUpgrade: { type: "scopeUpgrade" } as never,
      update: null,
    });
    expect(
      entries.map((entry) => (entry.type === "approval" ? entry.approval.id : entry.type)),
    ).toEqual(["scopeUpgrade", "new", "mention", "attention", "old"]);
  });

  it("derives every tab count and dismiss control from one entry list", () => {
    const entries = inbox(true, {
      approvals: [
        {
          id: "approval-1",
          kind: "exec",
          request: { command: "pwd" },
          createdAtMs: 1,
          expiresAtMs: 60_000,
        },
      ],
      attention: accountWarning(1),
      mentions: [
        { ...inboxMention("older"), createdAt: 1_000 },
        { ...inboxMention("newer"), createdAt: 2_000 },
      ],
      scopeUpgrade: buildScopeUpgradeInboxEntry({
        scopes: ["operator.read"],
        state: { phase: "available" },
      }),
    });

    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 6,
      approvals: 1,
      mentions: 2,
      system: 3,
    });
    expect(entries.filter((entry) => entry.dismissal).map((entry) => entry.type)).toEqual([
      "scopeUpgrade",
      "attention",
    ]);
    expect(
      entries.flatMap((entry) => (entry.type === "mention" ? [entry.mention.id] : [])),
    ).toEqual(["newer", "older"]);
  });

  it("keeps informational updates visible without adding them to attention counts", () => {
    const entries = inbox(false);

    expect(entries).toHaveLength(1);
    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 0,
      approvals: 0,
      mentions: 0,
      system: 0,
    });
  });
});
