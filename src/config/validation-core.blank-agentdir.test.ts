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

  it("reports the blank field issue before a duplicate-directory conflict", () => {
    const result = validateConfigObjectRaw(
      {
        agents: {
          ownership: "explicit",
          entries: {
            // A blank agentDir falls back to the agent's default directory; when
            // another agent points at that same directory, duplicate detection
            // would otherwise return first and mask the authored blank.
            alpha: { model: "openai/gpt-5.6", agentDir: " " },
            beta: {
              model: "openai/gpt-5.6",
              agentDir: "/tmp/probe-home/.openclaw/agents/alpha/agent",
            },
          },
        },
      } as never,
      { env: { HOME: "/tmp/probe-home", OPENCLAW_STATE_DIR: "/tmp/probe-home/.openclaw" } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected blank agentDir to fail validation");
    }
    expect(result.issues.map((issue) => issue.path)).toContain("agents.entries.alpha.agentDir");
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
