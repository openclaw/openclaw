// Configured hook tests cover the closed allowlist and open discovery decisions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInternalHookSelection } from "./configured.js";

const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: readConfigMachineStateMock,
}));

describe("resolveInternalHookSelection", () => {
  beforeEach(() => {
    readConfigMachineStateMock.mockReset();
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it("keeps CLI-shaped named entries closed when the master flag is enabled", () => {
    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              enabled: { enabled: true },
              disabled: { enabled: false },
            },
          },
        },
      }).names,
    ).toEqual(new Set(["enabled"]));

    expect(
      resolveInternalHookSelection({
        hooks: {
          internal: {
            enabled: true,
            entries: { disabled: { enabled: false } },
          },
        },
      }).names,
    ).toEqual(new Set());
  });

  it("uses declared install hook names as an allowlist", () => {
    readConfigMachineStateMock.mockReturnValue({
      pack: { source: "path", hooks: ["installed-one", "installed-two"] },
    });

    expect(resolveInternalHookSelection({}).names).toEqual(
      new Set(["installed-one", "installed-two"]),
    );
  });

  it("keeps installs with unknown dynamic hook names open-ended", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });

    expect(resolveInternalHookSelection({}).names).toBeNull();
  });
});
