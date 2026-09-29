import { describe, expect, it, vi } from "vitest";

const { support } = vi.hoisted(() => ({
  support: { value: { supported: true } as { supported: boolean; message?: string } },
}));

vi.mock("../../../infra/windows-appcontainer-spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../infra/windows-appcontainer-spawn.js")>();
  return {
    ...actual,
    assertAppContainerSpawnSupported: () => {
      if (!support.value.supported) {
        throw new actual.AppContainerSpawnUnsupportedError(support.value.message ?? "");
      }
    },
  };
});

import { AppContainerSpawnUnsupportedError } from "../../../infra/windows-appcontainer-spawn.js";
import { createChildAdapter } from "./child.js";

describe("createChildAdapter inside an AppContainer whose libuv cannot name child pipes", () => {
  it("rejects with the named error before preparing the child route", async () => {
    support.value = { supported: false, message: "libuv 1.52.1 in an AppContainer" };
    await expect(
      createChildAdapter({ argv: [process.execPath, "--version"] }),
    ).rejects.toBeInstanceOf(AppContainerSpawnUnsupportedError);
  });

  it("rejects with the named error before preparing the anchored-shell relay route", async () => {
    support.value = { supported: false, message: "libuv 1.52.1 in an AppContainer" };
    await expect(createChildAdapter({ anchoredShellCommand: "echo hi" })).rejects.toBeInstanceOf(
      AppContainerSpawnUnsupportedError,
    );
  });
});
