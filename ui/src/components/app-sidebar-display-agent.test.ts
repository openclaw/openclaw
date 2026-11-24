import { describe, expect, it } from "vitest";
import { resolveSidebarDisplayAgent } from "./app-sidebar-display-agent.ts";

type Input = Parameters<typeof resolveSidebarDisplayAgent>[0];

const main = { id: "main", name: "Main" };
const sessionKey = "agent:cooking-companion:main";
const creating = (admitted = false) =>
  ({
    creation: { sessionKey, admitted },
    displayName: "Cooking Companion",
    message: null,
    canDisplay: () => true,
  }) as NonNullable<Input["creation"]>;
const resolve = (input: Partial<Input>) =>
  resolveSidebarDisplayAgent({
    activeId: "main",
    roster: [main],
    identities: [],
    pending: undefined,
    creation: creating(),
    sessionKey,
    chipMode: true,
    ...input,
  });

describe("sidebar agent chip while an agent is created", () => {
  it("shows the agent being created as soon as its chat opens", () => {
    const pending = { id: "cooking-companion", name: "Cooking Companion" };
    expect(resolve({ pending }).agent).toBe(pending);
  });

  it("keeps showing it after admission clears the pending creation", () => {
    const admitted = { id: "cooking-companion", name: "Cooking Companion" };
    expect(resolve({ roster: [admitted, main] })).toMatchObject({
      activeId: "cooking-companion",
      agent: admitted,
    });
    // A roster refresh can briefly omit the agent the Gateway has not published yet.
    expect(resolve({}).agent).toEqual({ id: "cooking-companion", name: "Cooking Companion" });
  });

  it("returns to the selected agent once the creation is admitted or another chat is open", () => {
    expect(resolve({ creation: creating(true) }).agent).toBe(main);
    expect(resolve({ sessionKey: "agent:main:main" }).agent).toBe(main);
    expect(resolve({ chipMode: false }).agent).toBe(main);
  });
});
