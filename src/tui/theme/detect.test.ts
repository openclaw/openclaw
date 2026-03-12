import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectThemeName } from "./detect.js";

describe("detectThemeName", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENCLAW_THEME;
    delete process.env.COLORFGBG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to dark when no env vars set", () => {
    expect(detectThemeName()).toBe("dark");
  });

  it("respects OPENCLAW_THEME env var", () => {
    process.env.OPENCLAW_THEME = "dracula";
    expect(detectThemeName()).toBe("dracula");
  });

  it("trims OPENCLAW_THEME", () => {
    process.env.OPENCLAW_THEME = "  solarized-dark  ";
    expect(detectThemeName()).toBe("solarized-dark");
  });

  it("OPENCLAW_THEME takes precedence over COLORFGBG", () => {
    process.env.OPENCLAW_THEME = "catppuccin-mocha";
    process.env.COLORFGBG = "0;15";
    expect(detectThemeName()).toBe("catppuccin-mocha");
  });

  it("detects light terminal from COLORFGBG with bg=15 (white)", () => {
    process.env.COLORFGBG = "0;15";
    expect(detectThemeName()).toBe("light");
  });

  it("detects light terminal from COLORFGBG with bg=7 (light gray)", () => {
    process.env.COLORFGBG = "0;7";
    expect(detectThemeName()).toBe("light");
  });

  it("detects dark terminal from COLORFGBG with bg=0 (black)", () => {
    process.env.COLORFGBG = "15;0";
    expect(detectThemeName()).toBe("dark");
  });

  it("detects dark terminal from COLORFGBG with bg=4 (blue)", () => {
    process.env.COLORFGBG = "7;4";
    expect(detectThemeName()).toBe("dark");
  });

  it("handles three-part COLORFGBG (rxvt format)", () => {
    // Some terminals emit "fg;bg;..." or "fg;extra;bg"
    process.env.COLORFGBG = "0;0;15";
    expect(detectThemeName()).toBe("light");
  });

  it("defaults to dark for invalid COLORFGBG", () => {
    process.env.COLORFGBG = "invalid";
    expect(detectThemeName()).toBe("dark");
  });
});
