import { describe, expect, it } from "vitest";
import { resolveEffectiveResponseUsage } from "./thinking.js";

describe("resolveEffectiveResponseUsage", () => {
  it("defaults to off without a session or config", () => {
    expect(resolveEffectiveResponseUsage(undefined, undefined)).toBe("off");
  });

  it("uses the configured default for an unset session", () => {
    expect(resolveEffectiveResponseUsage(undefined, "tokens")).toBe("tokens");
  });

  it("selects the channel entry before the config default", () => {
    const config = { default: "off", discord: "full" } as const;
    expect(resolveEffectiveResponseUsage(undefined, config, "discord")).toBe("full");
    expect(resolveEffectiveResponseUsage(undefined, config, "whatsapp")).toBe("off");
  });

  it("preserves explicit session off over an enabled channel default", () => {
    expect(
      resolveEffectiveResponseUsage("off", { default: "full", discord: "full" }, "discord"),
    ).toBe("off");
  });
});
