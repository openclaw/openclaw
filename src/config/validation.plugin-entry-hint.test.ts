import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("plugin entry unrecognized key config hint", () => {
  it("suggests .config nesting for a single misplaced plugin key", () => {
    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          openshell: {
            enabled: true,
            policy: "/home/user/.openclaw/sandbox-policy.yaml",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "plugins.entries.openshell");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("did you mean plugins.entries.openshell.config.policy?");
      expect(issue?.message).toContain('Plugin-specific settings belong under the "config" key');
    }
  });

  it("suggests .config nesting for multiple misplaced plugin keys", () => {
    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          openshell: {
            enabled: true,
            policy: "/path/to/policy.yaml",
            mode: "strict",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "plugins.entries.openshell");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(
        "plugin-specific settings belong under plugins.entries.openshell.config",
      );
    }
  });

  it("does not add hint for unrecognized keys outside plugin entries", () => {
    const result = validateConfigObjectRaw({
      agents: {
        defaults: {
          notAKey: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "agents.defaults" && entry.message.includes("Unrecognized key"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).not.toContain("Plugin-specific settings");
      expect(issue?.message).not.toContain("did you mean");
    }
  });
});
