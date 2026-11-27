import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { findExtraGatewayServices, findSystemGatewayServices } from "./inspect.js";

// mock-isolation: Evaluating real launcher code is the import regression this fixture detects.
vi.mock("./schtasks-layout.js", () => {
  throw new Error("non-Windows and shallow inventory must not load Scheduled Task launchers");
});
// mock-isolation: Native task probes must stay unloaded outside deep Windows discovery.
vi.mock("./schtasks-state-probe.js", () => {
  throw new Error("non-Windows and shallow inventory must not load Scheduled Task probes");
});

afterEach(() => vi.restoreAllMocks());

it.each([
  ["linux", true],
  ["darwin", true],
  ["win32", false],
] as const)("keeps Windows inventory out of %s discovery (deep: %s)", async (platform, deep) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.spyOn(fs, "readdir").mockResolvedValue([]);

  await expect(findExtraGatewayServices({ HOME: "/fixture/home" }, { deep })).resolves.toEqual({
    services: [],
    errors: [],
  });
  await expect(findSystemGatewayServices()).resolves.toEqual([]);
});
