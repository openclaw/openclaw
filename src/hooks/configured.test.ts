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

  it("keeps installs with unknown dynamic hook names open-ended", () => {
    readConfigMachineStateMock.mockReturnValue({ pack: { source: "path" } });

    expect(resolveInternalHookSelection({}).names).toBeNull();
  });
});
