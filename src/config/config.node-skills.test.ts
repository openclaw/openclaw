import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("node skills config", () => {
  it("leaves node skill publication enabled by runtime default when unset", () => {
    const result = validateConfigObject({ gateway: { nodes: {} }, nodeHost: {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.nodes?.allowSkills).toBeUndefined();
      expect(result.config.nodeHost?.skills?.enabled).toBeUndefined();
    }
  });

  it("accepts explicitly disabled skills on both sides", () => {
    const result = validateConfigObject({
      gateway: { nodes: { allowSkills: false } },
      nodeHost: { skills: { enabled: false } },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects non-boolean enabled values", () => {
    const result = validateConfigObject({
      gateway: { nodes: { allowSkills: "yes" } },
      nodeHost: { skills: { enabled: "yes" } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "gateway.nodes.allowSkills")).toBe(true);
      expect(result.issues.some((issue) => issue.path === "nodeHost.skills.enabled")).toBe(true);
    }
  });
});
