import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayOperatorTurnAuthority } from "./operator-turn-authority.js";

describe("Gateway operator turn authority", () => {
  const config = {
    agents: { list: [{ id: "ops", default: true }] },
    session: { mainKey: "home" },
  } satisfies OpenClawConfig;

  it.each([
    ["main", "agent:ops:home"],
    ["home", "agent:ops:home"],
    ["incident-42", "incident-42"],
  ])("canonicalizes the %s session alias", (requested, canonical) => {
    const authority = createGatewayOperatorTurnAuthority({
      client: null,
      config,
      sessionKey: requested,
      conversationId: requested,
      trigger: "talk.agent-consult",
    });

    expect(authority.authorization).toMatchObject({
      agentId: "ops",
      sessionKey: canonical,
      conversationId: canonical,
    });
  });

  it("preserves the global session sentinel", () => {
    const authority = createGatewayOperatorTurnAuthority({
      client: null,
      config: { ...config, session: { scope: "global", mainKey: "home" } },
      sessionKey: "main",
      conversationId: "main",
      trigger: "talk.agent-consult",
    });

    expect(authority.authorization).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      conversationId: "global",
    });
  });
});
