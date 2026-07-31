import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

describe("session-store compatibility owner", () => {
  it("ignores a whitespace-only persisted owner and uses the retained owner", () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "   " } },
          entries: { ops: {}, research: {} },
        },
        session: { mainKey: "work", store: "/tmp/openclaw-fixed-sessions.json" },
      } satisfies OpenClawConfig,
      "ops",
    );

    expect(resolveSessionStoreKey({ cfg, sessionKey: "incident-42" })).toBe(
      "agent:ops:incident-42",
    );
  });
});
