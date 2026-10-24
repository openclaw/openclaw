import { describe, expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { agentRosterCards } from "./roster-activity.ts";

const roster = (
  ids: [string, ...string[]],
  overrides: Partial<AgentsListResult> = {},
): AgentsListResult => ({
  defaultId: ids[0],
  mainKey: "main",
  scope: "per-sender",
  agents: ids.map((id) => (id === "system" ? { id, kind: "system" } : { id })),
  ...overrides,
});
const row = (key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  ...fields,
});
const reply = (text: string, timestamp: number) => ({ text, timestamp });

describe("agent roster activity", () => {
  it.each([
    { key: "agent:main:subagent:recap", label: "Conversation recap" },
    { key: "agent:main:delegated", spawnedBy: "agent:main:main" },
    { key: "agent:main:internal-status", createdVia: "run" },
    { key: "agent:main:heartbeat", classification: "heartbeat" },
  ] satisfies Partial<GatewaySessionRow>[])(
    "keeps internal assistant output out of the preview: $key",
    (internal) => {
      const agents = roster(["main"]);
      const internalRow: GatewaySessionRow = {
        kind: "direct",
        updatedAt: 40,
        hasActiveRun: true,
        lastAssistantMessage: { text: '{"title":"Internal recap"}', timestamp: 30 },
        ...internal,
      };
      const cards = agentRosterCards(agents, [
        row("agent:main:main", { lastAssistantMessage: reply("Earlier reply", 10) }),
        row("agent:main:dashboard:delegated-work", {
          spawnedBy: "agent:main:main",
          lastAssistantMessage: reply("The validation is running.", 20),
        }),
        internalRow,
      ]);

      expect(cards[0]).toMatchObject({
        assistantPreview: "The validation is running.",
        activeNow: true,
        lastActiveAt: 40,
      });
      expect(agentRosterCards(agents, [internalRow])[0]?.assistantPreview).toBeUndefined();
    },
  );

  it("selects the latest assistant reply across sessions without using user activity", () => {
    const cards = agentRosterCards(roster(["main", "unanswered"]), [
      row("agent:main:main", {
        updatedAt: 100,
        lastMessagePreview: "New user question",
        lastAssistantMessage: reply("Earlier main reply", 10),
      }),
      row("agent:main:work", {
        updatedAt: 30,
        lastMessagePreview: "Another user question",
        lastAssistantMessage: reply("I have set up the template.", 20),
      }),
      row("agent:main:tied", {
        updatedAt: 50,
        lastAssistantMessage: reply("Tied reply", 20),
      }),
      row("agent:unanswered:main", {
        updatedAt: 200,
        lastMessagePreview: "Only a user message",
      }),
    ]);
    expect(cards.map((card) => card.assistantPreview)).toEqual([
      "I have set up the template.",
      undefined,
    ]);
    expect(cards[0]?.mainKey).toBe("agent:main:main");
  });

  it("preserves row ownership, recency ties, and canonical main precedence", () => {
    const identities: string[] = [];
    const rows: GatewaySessionRow[] = [
      row("agent:alpha:alias", { isMain: true, lastMessagePreview: "Alias" }),
      row("agent::ALPHA:task", { agentId: "beta", updatedAt: 9, unread: true }),
      row("foreign-key", { agentId: "beta", updatedAt: 7, lastMessagePreview: "First beta" }),
      row("agent:beta:second", { updatedAt: 7, lastMessagePreview: "Tied beta" }),
      row("agent:alpha:main", { updatedAt: 1, lastMessagePreview: "Canonical" }),
      row("unscoped", { updatedAt: 10, hasActiveRun: true }),
      row("agent:system:main", { updatedAt: 99, hasActiveRun: true }),
    ];
    const before = structuredClone(rows);
    const cards = agentRosterCards(
      roster(["beta", "system", "alpha", "empty"], { defaultId: "alpha" }),
      rows,
      (id) => {
        identities.push(id);
        return null;
      },
    );

    expect(cards).toMatchObject([
      { id: "beta", lastActiveAt: 7, preview: "First beta", activeNow: false },
      { id: "alpha", lastActiveAt: 10, preview: "Canonical", activeNow: true },
      { id: "empty", lastActiveAt: 0, preview: undefined, activeNow: false },
    ]);
    expect(identities).toEqual(["beta", "alpha", "empty"]);
    expect(rows).toEqual(before);
  });

  it("uses the canonical global main stream rather than a synthesized agent key", () => {
    const cards = agentRosterCards(roster(["main"], { scope: "global" }), [
      { key: "global", kind: "global", updatedAt: 1, lastMessagePreview: "Main stream" },
      row("agent:main:other", {
        updatedAt: 2,
        lastMessagePreview: "Other conversation",
      }),
    ]);
    expect(cards[0]).toMatchObject({ mainKey: "global", preview: "Main stream" });
  });

  it("aggregates work across sessions while keeping the main preview and identity", () => {
    const rows: GatewaySessionRow[] = [
      row("agent:harbor:other", { updatedAt: 9, lastMessagePreview: "Recent fallback" }),
      row("agent:ember:team", { updatedAt: 1, lastMessagePreview: "Main summary" }),
      row("agent:ember:work", {
        updatedAt: 4,
        hasActiveRun: true,
        lastMessagePreview: "Side task",
      }),
      row("foreign-key", { agentId: "ember", updatedAt: 6 }),
    ];
    const cards = agentRosterCards(
      roster(["harbor", "ember", "empty", "system"], { mainKey: "team" }),
      rows,
      (id) => (id === "ember" ? { agentId: id, name: "Ember", emoji: "🔥", avatar: "" } : null),
    );
    expect(cards).toMatchObject([
      { id: "harbor", activeNow: false, lastActiveAt: 9, preview: "Recent fallback" },
      {
        id: "ember",
        name: "Ember",
        textAvatar: "🔥",
        activeNow: true,
        lastActiveAt: 6,
        preview: "Main summary",
        mainKey: "agent:ember:team",
      },
      { id: "empty", activeNow: false, lastActiveAt: 0 },
    ]);
  });

  it("honors terminal run state and uses the main flag when its canonical key is absent", () => {
    const cards = agentRosterCards(roster(["alpha", "beta"], { defaultId: "beta" }), [
      row("agent:alpha:old", { updatedAt: 2, hasActiveRun: true, status: "done" }),
      row("agent:beta:main-alias", {
        isMain: true,
        lastMessagePreview: "Flagged main",
      }),
      row("agent:beta:recent", { updatedAt: 2, lastMessagePreview: "Other" }),
    ]);
    expect(cards.map((card) => card.id)).toEqual(["alpha", "beta"]);
    expect(cards.every((card) => !card.activeNow)).toBe(true);
    expect(cards[1]?.preview).toBe("Flagged main");
  });
});
