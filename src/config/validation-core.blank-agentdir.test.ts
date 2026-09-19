import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation-core.js";

describe("agent blank agentDir config", () => {
  it("reports a field-level issue for an explicitly blank per-agent agentDir", () => {
    const result = validateConfigObjectRaw({
      agents: { entries: { alpha: { agentDir: "   " } } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected blank per-agent agentDir to fail validation");
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "agents.entries.alpha.agentDir",
        message: expect.stringContaining("must not be blank"),
      }),
    );
  });

  it("accepts configs with no agentDir at all", () => {
    const result = validateConfigObjectRaw({ agents: { entries: { alpha: {} } } });

    expect(result.ok).toBe(true);
  });

  it("accepts a valid configured agentDir", () => {
    const result = validateConfigObjectRaw({
      agents: { entries: { alpha: { agentDir: "/tmp/openclaw-alpha" } } },
    });

    expect(result.ok).toBe(true);
  });
});
