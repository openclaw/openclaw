// Banner tests cover CLI banner rendering and suppression behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine } from "./banner.js";

const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const bannerOptions = {
  argv: ["node", "openclaw"],
  commit: "abc1234",
  env: { LANG: "en_US.UTF-8" },
  richTty: false,
  mode: "off" as const,
};

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
  if (stdoutIsTtyDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

async function importFreshBannerModule() {
  vi.resetModules();
  return await import("./banner.js");
}

function setStdoutIsTty(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

describe("formatCliBannerLine", () => {
  it("uses the default tagline when explicitly requested", () => {
    const line = formatCliBannerLine("2026.3.7", {
      ...bannerOptions,
      mode: "default",
    });

    expect(line).toBe("🦞 OpenClaw 2026.3.7 (abc1234) — All your chats, one OpenClaw.");
  });

  it("drops decorative emoji for generic Linux terminals", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    const line = formatCliBannerLine("2026.3.7", {
      ...bannerOptions,
    });

    expect(line).toBe("OpenClaw 2026.3.7 (abc1234)");
  });
});

describe("emitCliBanner", () => {
  it("does not write a banner without a TTY", async () => {
    const { emitCliBanner, hasEmittedCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(false);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    emitCliBanner("2026.3.7", {
      ...bannerOptions,
    });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(hasEmittedCliBanner()).toBe(false);
  });

  it.each([new Date(2026, 1, 26), new Date(2026, 1, 26, 23, 59)])(
    "selects the same ASCII lobster throughout %s",
    async (now) => {
      const { emitCliBanner } = await importFreshBannerModule();
      setStdoutIsTty(true);
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      vi.useFakeTimers({ now });
      emitCliBanner("2026.3.7", {
        ...bannerOptions,
        mode: "random",
        richTty: true,
      });

      const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(written).toContain(
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
    const { emitCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    vi.useFakeTimers({ now: now ?? new Date(2026, 1, 26) });
    emitCliBanner("2026.3.7", {
      ...bannerOptions,
      mode: "random",
      richTty: true,
      ...options,
    });

    const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).not.toContain("( o.o )");
    expect(written).not.toContain("~~~~~~~~~~~");
  });

  it("emits only once per module instance", async () => {
    const { emitCliBanner, hasEmittedCliBanner } = await importFreshBannerModule();
    setStdoutIsTty(true);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitCliBanner("2026.3.7", bannerOptions);
    emitCliBanner("2026.3.7", bannerOptions);

    expect(hasEmittedCliBanner()).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
