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
const previewRow = (
  key: string,
  updatedAt: number,
  lastMessagePreview: string,
  fields: Partial<GatewaySessionRow> = {},
) => row(key, { updatedAt, lastMessagePreview, ...fields });

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
      const internalRow = row(internal.key, {
        updatedAt: 40,
        hasActiveRun: true,
        lastAssistantMessage: { text: '{"title":"Internal recap"}', timestamp: 30 },
        ...internal,
      });
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
      previewRow("agent:main:main", 100, "New user question", {
        lastAssistantMessage: reply("Earlier main reply", 10),
      }),
      previewRow("agent:main:work", 30, "Another user question", {
        lastAssistantMessage: reply("I have set up the template.", 20),
      }),
      row("agent:main:tied", {
        updatedAt: 50,
        lastAssistantMessage: reply("Tied reply", 20),
      }),
      previewRow("agent:unanswered:main", 200, "Only a user message"),
    ]);
    expect(cards.map((card) => card.assistantPreview)).toEqual([
      "I have set up the template.",
      undefined,
    ]);
    expect(cards[0]?.mainKey).toBe("agent:main:main");
  });

  it("preserves row ownership, recency ties, and canonical main precedence", () => {
    const rows: GatewaySessionRow[] = [
      row("agent:alpha:alias", { isMain: true, lastMessagePreview: "Alias" }),
      row("agent::ALPHA:task", { agentId: "beta", updatedAt: 9, unread: true }),
      previewRow("foreign-key", 7, "First beta", { agentId: "beta" }),
      previewRow("agent:beta:second", 7, "Tied beta"),
      previewRow("agent:alpha:team", 1, "Canonical"),
      row("unscoped", { updatedAt: 10, hasActiveRun: true }),
      row("agent:system:main", { updatedAt: 99, hasActiveRun: true }),
    ];
    const before = structuredClone(rows);
    const cards = agentRosterCards(
      roster(["beta", "system", "alpha", "empty"], { defaultId: "alpha", mainKey: "team" }),
      rows,
      (id) => (id === "alpha" ? { agentId: id, name: "Alpha", emoji: "🔥", avatar: "" } : null),
    );

    expect(cards).toMatchObject([
      { id: "beta", lastActiveAt: 7, preview: "First beta", activeNow: false },
      {
        id: "alpha",
        name: "Alpha",
        textAvatar: "🔥",
        mainKey: "agent:alpha:team",
        lastActiveAt: 10,
        preview: "Canonical",
        activeNow: true,
      },
      { id: "empty", lastActiveAt: 0, preview: undefined, activeNow: false },
    ]);
    expect(rows).toEqual(before);
  });

  it("uses the canonical global main stream rather than a synthesized agent key", () => {
    const cards = agentRosterCards(roster(["main"], { scope: "global" }), [
      previewRow("global", 1, "Main stream", { kind: "global" }),
      previewRow("agent:main:other", 2, "Other conversation"),
    ]);
    expect(cards[0]).toMatchObject({ mainKey: "global", preview: "Main stream" });
  });

  it("honors terminal run state and uses the main flag when its canonical key is absent", () => {
    const cards = agentRosterCards(roster(["alpha", "beta"], { defaultId: "beta" }), [
      row("agent:alpha:old", { updatedAt: 2, hasActiveRun: true, status: "done" }),
      row("agent:beta:main-alias", { isMain: true, lastMessagePreview: "Flagged main" }),
      previewRow("agent:beta:recent", 2, "Other"),
    ]);
    expect(cards.map((card) => card.id)).toEqual(["alpha", "beta"]);
    expect(cards.every((card) => !card.activeNow)).toBe(true);
    expect(cards[1]?.preview).toBe("Flagged main");
  });
});
