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
const previewRow = (
  key: string,
  updatedAt: number,
  lastMessagePreview: string,
  fields: Partial<GatewaySessionRow> = {},
) => row(key, { updatedAt, lastMessagePreview, ...fields });

describe("roster-activity hidden agent handling", () => {
  it("includes hidden agents in roster cards for administration", () => {
    const agents = roster(["main", "worker"], {
      mainKey: "main",
      agents: [
        { id: "main", kind: "agent" as const },
        { id: "worker", kind: "agent" as const, hidden: true },
      ],
    });
    const cards = agentRosterCards(agents, [
      previewRow("agent:main:main", 100, "Main conversation"),
      previewRow("agent:worker:work", 50, "Worker task"),
    ]);
    // Both main and worker should be in cards (hidden agents stay selectable)
    expect(cards.map((c) => c.id)).toEqual(["main", "worker"]);
    expect(cards.find((c) => c.id === "worker")).toBeDefined();
  });

  it("includes picker-hidden agents with sessions in the roster sidebar", () => {
    // Regression test: hidden agents' open sessions should appear in team sidebar
    const agents = roster(["main", "automation"], {
      mainKey: "main",
      agents: [
        { id: "main", kind: "agent" as const },
        { id: "automation", kind: "agent" as const, hidden: true },
      ],
    });
    const cards = agentRosterCards(agents, [
      previewRow("agent:automation:task", 150, "Automation running"),
      previewRow("agent:main:main", 100, "User chat"),
    ]);
    // Both main and automation should appear (hidden agents stay selectable)
    // Order follows the roster's agent order
    expect(cards.map((c) => c.id)).toEqual(["main", "automation"]);
    expect(cards.find((c) => c.id === "automation")?.preview).toBe("Automation running");
  });
});
