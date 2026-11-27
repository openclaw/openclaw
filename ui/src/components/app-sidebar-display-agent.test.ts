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

  it("shows the Template's image until the new agent has an avatar of its own", () => {
    const avatarUrl = "data:image/png;base64,AAAA";
    const creation = { ...creating(), avatarUrl };
    const pending = { id: "cooking-companion", name: "Cooking Companion" };
    expect(resolve({ creation, pending })).toMatchObject({
      agent: { ...pending, identity: { avatarUrl } },
      identity: null,
    });
    // The agent is admitted before the Template's identity is written.
    const admitted = { agentId: "cooking-companion", name: "Cooking Companion", avatar: "" };
    expect(resolve({ creation, pending, identities: [admitted] }).identity).toEqual({
      ...admitted,
      avatar: avatarUrl,
    });
    const saved = { ...admitted, avatar: "/avatar/cooking-companion" };
    const own = resolve({ creation, pending, identities: [saved] });
    expect(own.agent).toBe(pending);
    expect(own.identity).toBe(saved);
    // Another agent's chip never borrows it.
    expect(resolve({ creation, sessionKey: "agent:main:main" }).agent).toBe(main);
  });

  it("keeps the Template's image across admission until the agent's own avatar arrives", () => {
    const avatarUrl = "data:image/png;base64,AAAA";
    const creation = { ...creating(true), avatarUrl };
    const row = { id: "cooking-companion", name: "Cooking Companion" };
    const input = { creation, activeId: "cooking-companion", roster: [row, main] };
    // The identity cached at admission still has no avatar, or was just retired.
    const stale = { agentId: "cooking-companion", name: "Cooking Companion", avatar: "" };
    expect(resolve({ ...input, identities: [stale] })).toMatchObject({
      agent: { ...row, identity: { avatarUrl } },
      identity: { ...stale, avatar: avatarUrl },
    });
    expect(resolve(input).agent).toEqual({ ...row, identity: { avatarUrl } });
    const saved = { ...row, identity: { avatarUrl: "/avatar/cooking-companion" } };
    expect(resolve({ ...input, roster: [saved, main] }).agent).toBe(saved);
    // The selected agent of an admitted creation is still only that creation's agent.
    expect(resolve({ ...input, activeId: "main" }).agent).toBe(main);
  });

  it("returns to the selected agent once the creation is admitted or another chat is open", () => {
    expect(resolve({ creation: creating(true) }).agent).toBe(main);
    expect(resolve({ sessionKey: "agent:main:main" }).agent).toBe(main);
    expect(resolve({ chipMode: false }).agent).toBe(main);
  });
});
