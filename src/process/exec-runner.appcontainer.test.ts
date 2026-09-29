import { describe, expect, it, vi } from "vitest";

const { support, resolveWindowsConsoleEncoding, spawnCommandWithInvocation } = vi.hoisted(() => ({
  support: { value: { supported: true } as { supported: boolean; message?: string } },
  resolveWindowsConsoleEncoding: vi.fn(() => null),
  spawnCommandWithInvocation: vi.fn(),
}));

vi.mock("../infra/windows-appcontainer-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/windows-appcontainer-spawn.js")>();
  return {
    ...actual,
    assertAppContainerSpawnSupported: () => {
      if (!support.value.supported) {
        throw new actual.AppContainerSpawnUnsupportedError(support.value.message ?? "");
      }
    },
  };
});
vi.mock("../infra/windows-encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/windows-encoding.js")>();
  return { ...actual, resolveWindowsConsoleEncoding };
});
vi.mock("./exec-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec-spawn.js")>();
  return { ...actual, spawnCommandWithInvocation };
});

import { AppContainerSpawnUnsupportedError } from "../infra/windows-appcontainer-spawn.js";
import { runCommandWithTimeout } from "./exec-runner.js";

describe("runCommandWithTimeout inside an AppContainer whose libuv cannot name child pipes", () => {
  it("throws the named error before the console-encoding probe or a spawn", async () => {
    support.value = { supported: false, message: "libuv 1.52.1 in an AppContainer" };
    await expect(runCommandWithTimeout([process.execPath, "--version"], 1000)).rejects.toThrow(
      AppContainerSpawnUnsupportedError,
    );
    // The probe and the spawn both hang inside the affected AppContainer, so the
    // guard must fire before either is reached.
    expect(resolveWindowsConsoleEncoding).not.toHaveBeenCalled();
    expect(spawnCommandWithInvocation).not.toHaveBeenCalled();
  });
});
