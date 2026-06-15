// Verifies gateway.tools.byClientId round-trips through the real config schema
// (regression guard: the strict gateway.tools object must accept the key, or a
// config that sets it is rejected at load/save/doctor time).
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config gateway.tools.byClientId schema", () => {
  it("accepts a byClientId allow/deny restriction map", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        tools: {
          allow: ["browser"],
          byClientId: {
            "example-restricted-ui": { allow: ["browser", "memory_search"] },
            "another-client": { deny: ["nodes"] },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown keys inside a byClientId entry (strict inner object)", () => {
    const result = validateConfigObjectRaw({
      gateway: {
        tools: {
          byClientId: {
            x: { allow: ["browser"], bogus: true },
          },
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
