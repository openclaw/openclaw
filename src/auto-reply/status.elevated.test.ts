import { describe, expect, it } from "vitest";
import { buildStatusMessage, statusModelRefs } from "../status/status-message.test-support.js";

describe("elevated status presentation", () => {
  it.each(["unknown", "off", "full"] as const)(
    "distinguishes elevation setting from %s effective state",
    (effective) => {
      const text = buildStatusMessage({
        modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-opus-4-6" }),
        config: {},
        agent: {},
        sessionKey: "agent:main:main",
        elevatedStatus: { setting: "full", effective },
        queue: { mode: "collect", depth: 0 },
      });
      expect(text).toContain(`elevated setting:full effective:${effective}`);
    },
  );

  it("shows verbose/elevated labels only when enabled", () => {
    const text = buildStatusMessage({
      modelRefs: statusModelRefs({ provider: "anthropic", model: "claude-opus-4-6" }),
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "v1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "low",
      resolvedVerbose: "on",
      resolvedElevated: "on",
      queue: { mode: "collect", depth: 0 },
    });

    expect(text).toContain("verbose");
    expect(text).toContain("elevated");
  });
});
