import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const readCliBannerTaglineModeMock = vi.hoisted(() => vi.fn());

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

beforeEach(() => {
  readCliBannerTaglineModeMock.mockReset();
  readCliBannerTaglineModeMock.mockReturnValue(undefined);
});

describe("formatCliBannerLine", () => {
  it("hides tagline text when cli.banner.taglineMode is off", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234)");
  });

  it("uses default tagline when cli.banner.taglineMode is default", () => {
    readCliBannerTaglineModeMock.mockReturnValue("default");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("prefers explicit tagline mode over config", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "darwin",
      richTty: false,
      mode: "default",
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("drops decorative emoji for generic Linux terminals", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      isTty: true,
      platform: "linux",
      richTty: false,
    });

    expect(line).toBe("OpenClaw 2026.3.7 (abc1234)");
  });
});

describe("banner emit-once guard with __testing reset (#83903)", () => {
  // Use a real-TTY shim around process.stdout.isTTY so emitCliBanner takes the
  // emission path. Each test resets the latched guard via the new __testing
  // helper introduced in #83903; without it, the second emitCliBanner call
  // would silently skip because bannerEmitted is still true from the first.
  it("emits the banner the first time and skips on subsequent calls without reset", async () => {
    const { emitCliBanner, hasEmittedCliBanner, __testing } = await import("./banner.js");
    __testing.resetBannerEmittedForTests();
    expect(hasEmittedCliBanner()).toBe(false);

    const originalTty = process.stdout.isTTY;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      emitCliBanner("2026.3.7", { argv: ["node", "openclaw"], isTty: true });
      expect(hasEmittedCliBanner()).toBe(true);
      expect(writes.length).toBeGreaterThan(0);

      const writesBefore = writes.length;
      emitCliBanner("2026.3.7", { argv: ["node", "openclaw"], isTty: true });
      expect(writes.length).toBe(writesBefore); // second emit suppressed
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
      __testing.resetBannerEmittedForTests();
    }
  });

  it("resets the emit-once guard so a follow-up scenario can re-emit", async () => {
    const { emitCliBanner, hasEmittedCliBanner, __testing } = await import("./banner.js");
    __testing.resetBannerEmittedForTests();
    expect(hasEmittedCliBanner()).toBe(false);

    const originalTty = process.stdout.isTTY;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      emitCliBanner("2026.3.7", { argv: ["node", "openclaw"], isTty: true });
      expect(hasEmittedCliBanner()).toBe(true);
      const firstWrites = writes.length;

      __testing.resetBannerEmittedForTests();
      expect(hasEmittedCliBanner()).toBe(false);

      emitCliBanner("2026.3.7", { argv: ["node", "openclaw"], isTty: true });
      expect(hasEmittedCliBanner()).toBe(true);
      expect(writes.length).toBeGreaterThan(firstWrites);
    } finally {
      process.stdout.write = originalWrite;
      Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
      __testing.resetBannerEmittedForTests();
    }
  });
});
