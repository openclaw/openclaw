import { describe, expect, it, vi } from "vitest";

const { support, execa } = vi.hoisted(() => ({
  support: { value: { supported: true } as { supported: boolean; message?: string } },
  execa: vi.fn(),
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
vi.mock("execa", () => ({ execa }));

import { AppContainerSpawnUnsupportedError } from "../infra/windows-appcontainer-spawn.js";
import { spawnCommand } from "./exec-spawn.js";

describe("spawnCommand inside an AppContainer whose libuv cannot name child pipes", () => {
  it("throws the named error before anything is spawned", () => {
    support.value = { supported: false, message: "libuv 1.52.1 in an AppContainer" };
    expect(() => spawnCommand([process.execPath, "--version"])).toThrow(
      AppContainerSpawnUnsupportedError,
    );
    expect(execa).not.toHaveBeenCalled();
  });
});
