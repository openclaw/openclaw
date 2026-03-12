import { describe, expect, it } from "vitest";
import { resolveCronAgentSessionKey } from "./session-key.js";

describe("resolveCronAgentSessionKey", () => {
  it("builds an agent-scoped key for legacy aliases", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "main", agentId: "main" })).toBe(
      "agent:main:main",
    );
  });

  it("preserves canonical agent keys instead of prefixing twice", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "agent:main:main", agentId: "main" })).toBe(
      "agent:main:main",
    );
  });

  it("normalizes canonical keys to lowercase before reuse", () => {
    expect(
      resolveCronAgentSessionKey({ sessionKey: "AGENT:Main:Hook:Webhook:42", agentId: "x" }),
    ).toBe("agent:main:hook:webhook:42");
  });

  it("keeps hook keys scoped under the target agent", () => {
    expect(resolveCronAgentSessionKey({ sessionKey: "hook:webhook:42", agentId: "main" })).toBe(
      "agent:main:hook:webhook:42",
    );
  });
});
