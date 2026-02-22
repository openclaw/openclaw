import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infra/git-commit.js", () => ({
  resolveCommitHash: () => "abc1234",
}));

vi.mock("../terminal/ansi.js", () => ({
  visibleWidth: (s: string) => s.length,
}));

vi.mock("../terminal/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    accentDim: (s: string) => s,
    accentBright: (s: string) => s,
    accent: (s: string) => s,
  },
}));

vi.mock("./tagline.js", () => ({
  pickTagline: () => "Test tagline here.",
}));

const { formatCliBannerLine } = await import("./banner.js");

describe("formatCliBannerLine quiet mode", () => {
  let originalArgv: string[];
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalArgv = [...process.argv];
    originalEnv = process.env.OPENCLAW_NO_TAGLINE;
    delete process.env.OPENCLAW_NO_TAGLINE;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_NO_TAGLINE;
    } else {
      process.env.OPENCLAW_NO_TAGLINE = originalEnv;
    }
  });

  it("includes tagline by default", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: false,
      argv: ["node", "openclaw", "status"],
    });
    expect(line).toContain("Test tagline here.");
    expect(line).toContain("1.0.0");
  });

  it("suppresses tagline when quiet option is true", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: false,
      quiet: true,
    });
    expect(line).not.toContain("Test tagline here.");
    expect(line).not.toContain("—");
    expect(line).toContain("1.0.0");
    expect(line).toContain("abc1234");
  });

  it("suppresses tagline when --quiet flag is in argv", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: false,
      argv: ["node", "openclaw", "--quiet", "status"],
    });
    expect(line).not.toContain("Test tagline here.");
    expect(line).toContain("1.0.0");
  });

  it("suppresses tagline when -q flag is in argv", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: false,
      argv: ["node", "openclaw", "-q", "status"],
    });
    expect(line).not.toContain("Test tagline here.");
    expect(line).toContain("1.0.0");
  });

  it("suppresses tagline when OPENCLAW_NO_TAGLINE env is set", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: false,
      env: { OPENCLAW_NO_TAGLINE: "1" },
      argv: ["node", "openclaw", "status"],
    });
    expect(line).not.toContain("Test tagline here.");
    expect(line).toContain("1.0.0");
  });

  it("suppresses tagline in rich mode when quiet", () => {
    const line = formatCliBannerLine("1.0.0", {
      commit: "abc1234",
      richTty: true,
      quiet: true,
    });
    expect(line).not.toContain("Test tagline here.");
    expect(line).not.toContain("—");
    expect(line).toContain("1.0.0");
  });
});
