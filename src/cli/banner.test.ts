import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  };
}
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

  it("emits only once per module instance", async () => {
    const { emit, hasEmittedCliBanner, write } = await captureBanner();
    emit();
    emit();
    expect(hasEmittedCliBanner()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
