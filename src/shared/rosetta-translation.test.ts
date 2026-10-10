import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const cpu = (model: string): os.CpuInfo => ({
  model,
  speed: 0,
  times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
});

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  { platform: "darwin", arch: "x64", model: "Apple M3 Ultra", translated: true },
  { platform: "darwin", arch: "x64", model: "VirtualApple @ 2.50GHz processor", translated: true },
  { platform: "darwin", arch: "x64", model: "Intel(R) Core(TM) i9-9980HK CPU", translated: false },
  { platform: "darwin", arch: "x64", model: "AMD EPYC 9454P 48-Core Processor", translated: false },
  { platform: "darwin", arch: "x64", model: undefined, translated: false },
  { platform: "darwin", arch: "arm64", model: "Apple M3 Ultra", translated: false },
  { platform: "linux", arch: "x64", model: "Apple M3 Ultra", translated: false },
] as const)(
  "reports $platform/$arch with CPU $model as translated=$translated",
  async ({ platform, arch, model, translated }) => {
    // The detector caches per process; each case needs a fresh module instance.
    vi.resetModules();
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(process, "arch", "get").mockReturnValue(arch);
    vi.spyOn(os, "cpus").mockReturnValue(model ? [cpu(model)] : []);
    const { isRosettaTranslatedProcess } = await import("./rosetta-translation.js");
    expect(isRosettaTranslatedProcess()).toBe(translated);
  },
);
