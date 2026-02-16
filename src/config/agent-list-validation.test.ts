import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("agents.list validation", () => {
  it("allows partial loading of valid agents and warns on invalid ones", () => {
    const res = validateConfigObjectRaw({
      agents: {
        list: [
          {
            id: "valid-agent",
            name: "Valid Agent",
          },
          {
            id: "invalid-agent",
            unknownProp: "should fail strict validation",
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      // Valid agent should remain
      expect(res.config.agents?.list).toHaveLength(1);
      expect(res.config.agents?.list?.[0].id).toBe("valid-agent");

      // Invalid agent should be in warnings
      expect(res.warnings).toBeDefined();
      expect(res.warnings.length).toBeGreaterThan(0);
      const warning = res.warnings.find((w) => w.path.includes("agents.list.1"));
      expect(warning).toBeDefined();
      expect(warning?.message).toMatch(/Unrecognized key/i);
    }
  });
});
