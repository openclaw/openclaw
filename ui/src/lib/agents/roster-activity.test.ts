import { describe, expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { agentRosterCards } from "./roster-activity.ts";

describe("agent roster activity", () => {
  it("preserves row ownership, recency ties, and canonical main precedence", () => {
    const identities: string[] = [];
    const rows: GatewaySessionRow[] = [
      { key: "agent:alpha:alias", kind: "direct", isMain: true, lastMessagePreview: "Alias" },
      { key: "agent::ALPHA:task", agentId: "beta", kind: "direct", updatedAt: 9, unread: true },
      {
        key: "foreign-key",
        agentId: "beta",
        kind: "direct",
        updatedAt: 7,
        lastMessagePreview: "First beta",
      },
      { key: "agent:beta:second", kind: "direct", updatedAt: 7, lastMessagePreview: "Tied beta" },
      { key: "agent:alpha:main", kind: "direct", updatedAt: 1, lastMessagePreview: "Canonical" },
      { key: "unscoped", kind: "direct", updatedAt: 10, hasActiveRun: true },
      { key: "agent:system:main", kind: "direct", updatedAt: 99, hasActiveRun: true },
    ];
    const before = structuredClone(rows);
    const cards = agentRosterCards(
      {
        defaultId: "alpha",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "beta" },
          { id: "system", kind: "system" },
          { id: "alpha" },
          { id: "empty" },
        ],
      },
      rows,
      (id) => {
        identities.push(id);
        return null;
      },
    );

    expect(cards).toMatchObject([
      { id: "beta", lastActiveAt: 7, preview: "First beta", activeNow: false, unreadCount: 0 },
      { id: "alpha", lastActiveAt: 10, preview: "Canonical", activeNow: true, unreadCount: 1 },
      { id: "empty", lastActiveAt: 0, preview: undefined, activeNow: false, unreadCount: 0 },
    ]);
    expect(identities).toEqual(["beta", "alpha", "empty"]);
    expect(rows).toEqual(before);
  });

  it("uses the canonical global main stream rather than a synthesized agent key", () => {
    const cards = agentRosterCards(
      { defaultId: "main", mainKey: "main", scope: "global", agents: [{ id: "main" }] },
      [
        { key: "global", kind: "global", updatedAt: 1, lastMessagePreview: "Main stream" },
        {
          key: "agent:main:other",
          kind: "direct",
          updatedAt: 2,
          lastMessagePreview: "Other conversation",
        },
      ],
    );
    expect(cards[0]).toMatchObject({ mainKey: "global", preview: "Main stream" });
  });

  it("aggregates work across sessions while keeping the main preview and identity", () => {
    const roster: AgentsListResult = {
      defaultId: "harbor",
      mainKey: "team",
      scope: "per-sender",
      agents: [
        { id: "harbor" },
        { id: "ember" },
        { id: "empty" },
        { id: "system", kind: "system" },
      ],
    };
    const rows: GatewaySessionRow[] = [
      {
        key: "agent:harbor:other",
        kind: "direct",
        updatedAt: 9,
        lastMessagePreview: "Recent fallback",
      },
      { key: "agent:ember:team", kind: "direct", updatedAt: 1, lastMessagePreview: "Main summary" },
      {
        key: "agent:ember:work",
        kind: "direct",
        updatedAt: 4,
        hasActiveRun: true,
        lastMessagePreview: "Side task",
      },
      { key: "foreign-key", agentId: "ember", kind: "direct", updatedAt: 6 },
    ];
    const cards = agentRosterCards(roster, rows, (id) =>
      id === "ember" ? { agentId: id, name: "Ember", emoji: "🔥", avatar: "" } : null,
    );
    expect(cards.map((card) => card.id)).toEqual(["harbor", "ember", "empty"]);
    expect(cards[1]).toMatchObject({
      name: "Ember",
      textAvatar: "🔥",
      activeNow: true,
      lastActiveAt: 6,
      preview: "Main summary",
      mainKey: "agent:ember:team",
    });
    expect(cards[0]).toMatchObject({
      activeNow: false,
      lastActiveAt: 9,
      preview: "Recent fallback",
    });
    expect(cards[2]).toMatchObject({ activeNow: false, lastActiveAt: 0, preview: undefined });
  });

  it("honors terminal run state and uses the main flag when its canonical key is absent", () => {
    const roster: AgentsListResult = {
      defaultId: "beta",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "alpha" }, { id: "beta" }],
    };
    const cards = agentRosterCards(roster, [
      { key: "agent:alpha:old", kind: "direct", updatedAt: 2, hasActiveRun: true, status: "done" },
      {
        key: "agent:beta:main-alias",
        kind: "direct",
        isMain: true,
        lastMessagePreview: "Flagged main",
      },
      { key: "agent:beta:recent", kind: "direct", updatedAt: 2, lastMessagePreview: "Other" },
    ]);
    expect(cards.map((card) => card.id)).toEqual(["alpha", "beta"]);
    expect(cards.every((card) => !card.activeNow)).toBe(true);
    expect(cards[1]?.preview).toBe("Flagged main");
  });
});
