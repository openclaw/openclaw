import { describe, expect, it } from "vitest";
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import type { OpenClawConfig } from "./types.js";

describe("session store ownership preparation", () => {
  it.each([
    {
      agents: { defaults: { sessionStore: { agentId: "main" } } },
      expected: {},
    },
    {
      agents: {
        defaults: { sessionStore: { agentId: "main" }, workspace: "/fixture/workspace" },
        entries: { main: { name: "Main" } },
      },
      expected: {
        defaults: { workspace: "/fixture/workspace" },
        entries: { main: { name: "Main" } },
      },
    },
  ])("clears copied ownership without mutating the submitted config", ({ agents, expected }) => {
    const targetConfig: OpenClawConfig = {
      session: { store: "/fixture/new-{agentId}/sessions.db" },
      agents,
    };
    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig: { agents: { defaults: { sessionStore: { agentId: "main" } } } },
      currentStore: "/fixture/old-{agentId}/sessions.db",
      targetConfig,
      env: {},
    });

    expect(result.config).toEqual({ session: targetConfig.session, agents: expected });
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
    expect(targetConfig.agents?.defaults?.sessionStore).toEqual({ agentId: "main" });
  });
});
