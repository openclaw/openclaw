import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { launchdTestState } from "./launchd-state.test-support.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { createLaunchdFileSystem } = await import("./launchd-fs.test-support.js");
  const wrapped = createLaunchdFileSystem(actual, launchdTestState);
  launchdTestState.resolveFsPath = wrapped.resolveFixturePath;
  return { ...wrapped, default: wrapped };
});

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/advanced")>();
  return {
    ...actual,
    readRegularFile: (params: Parameters<typeof actual.readRegularFile>[0]) =>
      actual.readRegularFile({
        ...params,
        filePath: expectDefined(
          launchdTestState.resolveFsPath,
          "launchd fixture path resolver",
        )(params.filePath),
      }),
  };
});
