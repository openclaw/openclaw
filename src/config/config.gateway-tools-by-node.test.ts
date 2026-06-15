// Verifies gateway.tools.byNode round-trips through the real config schema
// (regression guard: the strict gateway.tools object must accept the key, or a
// config that sets it is rejected at load/save/doctor time).
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config gateway.tools.byNode schema", () => {
  it("accepts a byNode allow/deny restriction map", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        tools: {
          allow: ["browser"],
          byNode: {
            "node-abc": { allow: ["browser", "memory_search"] },
            "node-xyz": { deny: ["nodes"] },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown keys inside a byNode entry (strict inner object)", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        tools: {
          byNode: {
            x: { allow: ["browser"], bogus: true },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
