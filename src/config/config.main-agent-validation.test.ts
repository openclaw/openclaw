// Verifies that configuration validation requires the main agent entry.
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("config main agent validation", () => {
  it("rejects configuration missing the main agent entry", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "secondary",
            name: "Secondary Agent",
          },
          {
            id: "tertiary",
            name: "Tertiary Agent",
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toContainEqual({
      path: "agents.list",
      message: expect.stringContaining('Missing required "main" agent entry'),
      severity: "error",
    });
  });

  it("accepts configuration with main agent present", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
          },
          {
            id: "secondary",
            name: "Secondary Agent",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts configuration with main agent not in first position", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "secondary",
            name: "Secondary Agent",
          },
          {
            id: "main",
            name: "Main",
          },
          {
            id: "tertiary",
            name: "Tertiary Agent",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects empty agents list", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toContainEqual({
      path: "agents.list",
      message: expect.stringContaining('Missing required "main" agent entry'),
      severity: "error",
    });
  });

  it("rejects configuration with main agent having wrong id casing", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "Main", // Wrong casing
            name: "Main Agent",
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toContainEqual({
      path: "agents.list",
      message: expect.stringContaining('Missing required "main" agent entry'),
      severity: "error",
    });
  });

  it("rejects configuration with null agent entries alongside valid ones", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          null,
          {
            id: "secondary",
            name: "Secondary",
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    // The validation will first report the null entry issue, but should also
    // report missing main agent if no valid main agent exists
    expect(res.issues.some((issue) => issue.path.startsWith("agents.list"))).toBe(true);
  });

  it("accepts configuration with minimal main agent entry", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
            // Minimal configuration, no model or other fields
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts configuration with fully specified main agent", () => {
    const res = validateConfigObjectWithPlugins({
      agents: {
        list: [
          {
            id: "main",
            name: "Main",
            model: {
              primary: "openai/gpt-4o",
            },
            workspace: "./workspace/main",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });
});
