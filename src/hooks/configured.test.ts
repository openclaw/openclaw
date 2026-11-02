// Configured hook tests cover the closed allowlist and open discovery decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalHookSelection } from "./configured.js";

const readHookInstallsMock = vi.hoisted(() => vi.fn());

vi.mock("./installs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installs.js")>()),
  readHookInstallsAsync: readHookInstallsMock,
}));

describe("resolveInternalHookSelection", () => {
  beforeEach(() => {
    readHookInstallsMock.mockReset();
    readHookInstallsMock.mockResolvedValue({});
  });

  it("keeps CLI-shaped named entries closed when the master flag is enabled", async () => {
    expect(
      (
        await resolveInternalHookSelection({
          hooks: {
            internal: {
              enabled: true,
              entries: {
                enabled: { enabled: true },
                disabled: { enabled: false },
              },
            },
          },
        })
      ).names,
    ).toEqual(new Set(["enabled"]));

    expect(
      (
        await resolveInternalHookSelection({
          hooks: {
            internal: {
              enabled: true,
              entries: { disabled: { enabled: false } },
            },
          },
        })
      ).names,
    ).toEqual(new Set());
  });

  it("uses declared install hook names as an allowlist", async () => {
    readHookInstallsMock.mockResolvedValue({
      pack: { source: "path", hooks: ["installed-one", "installed-two"] },
    });

    expect((await resolveInternalHookSelection({})).names).toEqual(
      new Set(["installed-one", "installed-two"]),
    );
  });

  it("keeps installs with unknown dynamic hook names open-ended", async () => {
    readHookInstallsMock.mockResolvedValue({ pack: { source: "path" } });

    expect((await resolveInternalHookSelection({})).names).toBeNull();
  });
});
