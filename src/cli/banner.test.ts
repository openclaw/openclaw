import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const { set: setStdoutIsTty, restore: restoreStdoutIsTty } = createCliTtyMock([process.stdout]);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const bannerOptions = {
  argv: ["node", "openclaw"],
  commit: "abc1234",
  env: { LANG: "en_US.UTF-8" },
  richTty: false,
  mode: "off" as const,
};
const formatBanner = (options: Parameters<typeof formatCliBannerLine>[1] = {}) =>
  formatCliBannerLine("2026.3.7", { ...bannerOptions, ...options });
const firstTagline =
  "Your terminal just grew claws—type something and let the bot pinch the busywork.";

beforeEach(() => {
  setStdoutIsTty(true);
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  for (const key of ["TERM_PROGRAM", "WT_SESSION", "LC_ALL", "LC_CTYPE"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("LANG", "en_US.UTF-8");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platformDescriptor);
  restoreStdoutIsTty();
});

async function captureBanner() {
  vi.resetModules();
  const { emitCliBanner, hasEmittedCliBanner } = await import("./banner.js");
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    emit: (options: Parameters<typeof emitCliBanner>[1] = {}) =>
      emitCliBanner("2026.3.7", { ...bannerOptions, ...options }),
    hasEmittedCliBanner,
    write,
    output: () => write.mock.calls.map(([chunk]) => String(chunk)).join(""),
  };
}

describe("formatCliBannerLine", () => {
  it.each([
    ["off", "🦞 OpenClaw 2026.3.7 (abc1234)"],
    ["default", "🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw."],
  ] as const)("formats %s tagline mode", (mode, expected) => {
    expect(formatBanner({ mode })).toBe(expected);
  });
  it.each(["0", "1abc"])("selects a complete index or falls back for %s", (index) => {
    vi.spyOn(Math, "random").mockReturnValue(index === "0" ? 0.75 : 0);
    const line = formatBanner({
      mode: "random",
      env: { ...bannerOptions.env, OPENCLAW_TAGLINE_INDEX: index },
    });
    expect(line).toContain(firstTagline);
    expect(line).not.toContain("All your chats, one OpenClaw.");
  });

  it("drops decorative emoji for generic Linux terminals", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    expect(formatBanner()).toBe("OpenClaw 2026.3.7 (abc1234)");
  });
});

describe("future holiday tagline windows (2028-2030)", () => {
  beforeEach(() => vi.useFakeTimers());

  // Sample the public banner across the random pool at a fixed UTC date so
  // floating holidays remain visible without exporting the selection machinery.
  it.each([
    [2029, 10, 5],
    [2030, 9, 25],
  ])("activates Diwali on %i-%i-%i", (year, monthIndex, day) => {
    vi.setSystemTime(Date.UTC(year, monthIndex, day, 12, 0, 0));
    const random = vi.spyOn(Math, "random");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      random.mockReturnValue(i / 200);
      seen.add(formatBanner({ mode: "random" }));
    }
    expect([...seen].some((line) => line.toLowerCase().includes("diwali"))).toBe(true);
  });
});

describe("emitCliBanner", () => {
  it.each([
    { args: ["--json"], suppressed: true },
    { args: ["--json=true"], suppressed: true },
    { args: ["--version"], suppressed: true },
    { args: ["-V"], suppressed: true },
    { args: ["-v"], suppressed: true },
    { args: ["acp", "-v"], suppressed: false },
  ])("respects banner suppression for $args", async ({ args, suppressed }) => {
    const { emit, hasEmittedCliBanner, write } = await captureBanner();
    emit({ argv: ["node", "openclaw", ...args] });
    expect(write).toHaveBeenCalledTimes(suppressed ? 0 : 1);
    expect(hasEmittedCliBanner()).toBe(!suppressed);
  });

  it("does not write a banner without a TTY", async () => {
    const { emit, hasEmittedCliBanner, write } = await captureBanner();
    setStdoutIsTty(false);
    emit();
    expect(write).not.toHaveBeenCalled();
    expect(hasEmittedCliBanner()).toBe(false);
  });

  it.each([new Date(2026, 1, 26), new Date(2026, 1, 26, 23, 59)])(
    "selects the same ASCII lobster throughout %s",
    async (now) => {
      const { emit, output } = await captureBanner();
      vi.useFakeTimers({ now });
      emit({ mode: "random", richTty: true });
      expect(output()).toContain(
        ["  (\\/)  (\\/)", "   \\_\\  /_/", "    ( o.o )", "    /|__|\\"].join("\n"),
      );
    },
  );

  it.each([
    { label: "plain terminals", options: { richTty: false } },
    { label: "off mode", options: { mode: "off" as const } },
    { label: "default mode", options: { mode: "default" as const } },
    { label: "non-lobster days", options: {}, now: new Date(2026, 0, 1) },
    { label: "CI", options: { env: { CI: "1" } } },
    { label: "tests", options: { env: { VITEST: "true" } } },
  ])("keeps lobster day out of $label", async ({ options, now }) => {
    const { emit, output } = await captureBanner();
    vi.useFakeTimers({ now: now ?? new Date(2026, 1, 26) });
    emit({ mode: "random", richTty: true, ...options });
    expect(output()).not.toContain("( o.o )");
    expect(output()).not.toContain("~~~~~~~~~~~");
  });

  it("emits only once per module instance", async () => {
    const { emit, hasEmittedCliBanner, write } = await captureBanner();
    emit();
    emit();
    expect(hasEmittedCliBanner()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
