import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitCliBanner, formatCliBannerLine, hasEmittedCliBanner, __testing } from "./banner.js";

const readCliBannerTaglineModeMock = vi.hoisted(() => vi.fn());

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

beforeEach(() => {
  readCliBannerTaglineModeMock.mockReset();
  readCliBannerTaglineModeMock.mockReturnValue(undefined);
  __testing.resetBannerEmittedForTests();
});

afterEach(() => {
  __testing.resetBannerEmittedForTests();
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

describe("emitCliBanner", () => {
  it("can reset the one-shot emission guard for isolated tests", () => {
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      emitCliBanner("2026.3.7", {
        argv: ["node", "openclaw"],
        commit: "abc1234",
        env: { LANG: "en_US.UTF-8" },
        isTty: true,
        platform: "darwin",
        richTty: false,
        mode: "off",
      });

      expect(hasEmittedCliBanner()).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);

      emitCliBanner("2026.3.7", {
        argv: ["node", "openclaw"],
        commit: "abc1234",
        mode: "off",
      });

      expect(write).toHaveBeenCalledTimes(1);

      __testing.resetBannerEmittedForTests();

      expect(hasEmittedCliBanner()).toBe(false);

      emitCliBanner("2026.3.7", {
        argv: ["node", "openclaw"],
        commit: "abc1234",
        env: { LANG: "en_US.UTF-8" },
        isTty: true,
        platform: "darwin",
        richTty: false,
        mode: "off",
      });

      expect(hasEmittedCliBanner()).toBe(true);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      write.mockRestore();
      if (stdoutTty) {
        Object.defineProperty(process.stdout, "isTTY", stdoutTty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
