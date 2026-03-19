import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readCliBannerTaglineModeMock = vi.fn();
const loadConfigMock = vi.fn();
const resolveScriptTaglineMock = vi.fn();

vi.mock("./banner-config-lite.js", () => ({
  readCliBannerTaglineMode: readCliBannerTaglineModeMock,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./tagline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tagline.js")>();
  return { ...actual, resolveScriptTagline: resolveScriptTaglineMock };
});

let formatCliBannerLine: typeof import("./banner.js").formatCliBannerLine;
let emitCliBanner: typeof import("./banner.js").emitCliBanner;

beforeAll(async () => {
  ({ formatCliBannerLine, emitCliBanner } = await import("./banner.js"));
});

beforeEach(() => {
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
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234)");
  });

  it("uses default tagline when cli.banner.taglineMode is default", () => {
    readCliBannerTaglineModeMock.mockReturnValue("default");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      richTty: false,
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("prefers explicit tagline mode over config", () => {
    readCliBannerTaglineModeMock.mockReturnValue("off");

    const line = formatCliBannerLine("2026.3.7", {
      commit: "abc1234",
      richTty: false,
      mode: "default",
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });
});

describe("emitCliBanner with script mode", () => {
  it("reads taglineScriptFile from config and calls resolveScriptTagline", async () => {
    readCliBannerTaglineModeMock.mockReturnValue("script");
    loadConfigMock.mockReturnValue({ cli: { banner: { taglineScriptFile: "/path/to/tagline.js" } } });
    resolveScriptTaglineMock.mockResolvedValue("Custom tagline from script");

    // Patch stdout so emitCliBanner treats it as a TTY
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
