/** Tests response-usage configuration precedence independently from thinking profiles. */
import { describe, expect, it } from "vitest";
import { resolveEffectiveResponseUsage } from "./thinking.js";

describe("resolveEffectiveResponseUsage", () => {
  it("returns off when session is unset and no config is provided", () => {
    expect(resolveEffectiveResponseUsage(undefined, undefined)).toBe("off");
    expect(resolveEffectiveResponseUsage(null, undefined)).toBe("off");
  });

  it("applies config default when session is unset", () => {
    expect(resolveEffectiveResponseUsage(undefined, "tokens")).toBe("tokens");
    expect(resolveEffectiveResponseUsage(undefined, "full")).toBe("full");
  });

  it("applies per-channel config entry when session is unset", () => {
    const cfg = { default: "off", discord: "full", telegram: "tokens" } as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg, "discord")).toBe("full");
    expect(resolveEffectiveResponseUsage(undefined, cfg, "telegram")).toBe("tokens");
    // Unknown channel falls back to config default
    expect(resolveEffectiveResponseUsage(undefined, cfg, "whatsapp")).toBe("off");
  });

  it("session explicit off overrides any config default", () => {
    // Explicit "off" is stored and wins — non-off config default cannot re-enable it.
    expect(resolveEffectiveResponseUsage("off", "tokens")).toBe("off");
    expect(resolveEffectiveResponseUsage("off", "full")).toBe("off");
    expect(
      resolveEffectiveResponseUsage("off", { default: "full", discord: "full" }, "discord"),
    ).toBe("off");
  });

  it("session explicit on value overrides config default", () => {
    expect(resolveEffectiveResponseUsage("tokens", "full")).toBe("tokens");
    expect(resolveEffectiveResponseUsage("full", "off")).toBe("full");
  });

  it("unset (undefined/null) falls through to config; explicit off does not", () => {
    // These two are distinct states:
    // - undefined = unset/inherit → gets config default
    // - "off"     = explicit off  → stays off
    const cfg = "tokens" as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg)).toBe("tokens"); // inherits
    expect(resolveEffectiveResponseUsage("off", cfg)).toBe("off"); // explicit off persists
  });
});
