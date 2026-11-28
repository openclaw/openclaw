import { expect, it } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";

it("keeps blank channel ids isolated from the main session", () => {
  expect(
    buildAgentSessionKey({
      agentId: "main",
      channel: "quietchat",
      accountId: "default",
      peer: { kind: "channel", id: "   " },
    }),
  ).toBe("agent:main:quietchat:channel:unknown");
});
