import { describe, expect, it } from "vitest";
import { prependSecurityPreamble, resolveSecurityPreamble } from "./system-preamble.js";

describe("resolveSecurityPreamble", () => {
  it("returns the preamble by default when config is empty", () => {
    const preamble = resolveSecurityPreamble({});
    expect(preamble).toBeDefined();
    expect(preamble).toContain("SECURITY RULES");
    expect(preamble).toContain("potentially adversarial");
  });

  it("returns the preamble when config is undefined", () => {
    expect(resolveSecurityPreamble(undefined)).toBeDefined();
  });

  it("returns null when enforce is explicitly false", () => {
    const cfg = {
      agents: {
        defaults: {
          systemPreamble: { enforce: false },
        },
      },
    };
    expect(resolveSecurityPreamble(cfg as never)).toBeNull();
  });

  it("returns the preamble when enforce is explicitly true", () => {
    const cfg = {
      agents: {
        defaults: {
          systemPreamble: { enforce: true },
        },
      },
    };
    expect(resolveSecurityPreamble(cfg as never)).toContain("SECURITY RULES");
  });
});

describe("prependSecurityPreamble", () => {
  it("prepends preamble to existing instructions", () => {
    const result = prependSecurityPreamble("You are a helpful assistant.", {});
    expect(result).toMatch(/^SECURITY RULES/);
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("---");
  });

  it("returns just the preamble when instructions are empty", () => {
    const result = prependSecurityPreamble("", {});
    expect(result).toContain("SECURITY RULES");
    expect(result).not.toContain("---");
  });

  it("returns original instructions when enforce is false", () => {
    const cfg = {
      agents: {
        defaults: {
          systemPreamble: { enforce: false },
        },
      },
    };
    const result = prependSecurityPreamble("Custom instructions only.", cfg as never);
    expect(result).toBe("Custom instructions only.");
    expect(result).not.toContain("SECURITY RULES");
  });
});
