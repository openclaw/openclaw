import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine, emitCliBanner, _resetBannerStateForTest as resetBannerState } from "./banner.js";

const readCliBannerTaglineModeMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveScriptTaglineMock = vi.hoisted(() => vi.fn());

vi.mock("./banner-config-lite.js", () => ({
  parseTaglineMode: (value: unknown) =>
    value === "random" || value === "default" || value === "off" ? value : undefined,
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./tagline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tagline.js")>();
  return { ...actual, resolveScriptTagline: resolveScriptTaglineMock };
});


beforeEach(() => {
  resetBannerState?.();
  readCliBannerTaglineModeMock.mockReset();
  readCliBannerTaglineModeMock.mockReturnValue(undefined);
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({});
  resolveScriptTaglineMock.mockReset();
  resolveScriptTaglineMock.mockResolvedValue(undefined);
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

describe("emitCliBanner with script mode", () => {
  it("reads taglineScriptFile from config and calls resolveScriptTagline", async () => {
    readCliBannerTaglineModeMock.mockReturnValue("script");
    loadConfigMock.mockReturnValue({ cli: { banner: { taglineScriptFile: "/path/to/tagline.js" } } });
    resolveScriptTaglineMock.mockResolvedValue("Custom tagline from script");

    const origIsTTY = process.stdout.isTTY;
    const origWrite = process.stdout.write.bind(process.stdout);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const writes: string[] = [];
    process.stdout.write = (chunk: unknown) => { writes.push(String(chunk)); return true; };

    try {
      await emitCliBanner("2026.3.7", { argv: [], commit: "abc1234", richTty: false });
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origIsTTY, configurable: true });
      process.stdout.write = origWrite;
    }

    expect(resolveScriptTaglineMock).toHaveBeenCalledWith("/path/to/tagline.js");
    expect(writes.join("")).toContain("Custom tagline from script");
  });
});
