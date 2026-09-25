import { beforeEach, describe, expect, it, vi } from "vitest";

const restoreTerminalState = vi.hoisted(() => vi.fn());
const withTuiAfterUpdateGate = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState }));
vi.mock("../tui/tui-update-gate.js", () => ({ withTuiAfterUpdateGate }));

import { runSetupTui } from "./setup.finalize-tui.js";

describe("runSetupTui", () => {
  beforeEach(() => {
    restoreTerminalState.mockClear();
    withTuiAfterUpdateGate.mockReset();
  });

  it("restores the terminal and closes the session gateway when the gate rejects", async () => {
    const gateError = new Error("update discovery unavailable");
    withTuiAfterUpdateGate.mockRejectedValueOnce(gateError);
    const gateway = {} as never;
    const sessionGateway = { current: gateway };
    const closeSessionGateway = vi.fn(async () => {});

    await expect(
      runSetupTui({
        config: {},
        gatewayReachable: true,
        gatewayUrl: "ws://127.0.0.1:18789",
        sessionGateway,
        closeSessionGateway,
      }),
    ).rejects.toBe(gateError);

    expect(restoreTerminalState).toHaveBeenNthCalledWith(1, "pre-setup tui", {
      resumeStdinIfPaused: false,
    });
    expect(restoreTerminalState).toHaveBeenNthCalledWith(2, "post-setup tui", {
      resumeStdinIfPaused: false,
    });
    expect(closeSessionGateway).toHaveBeenCalledWith(gateway);
    expect(sessionGateway.current).toBeUndefined();
  });

  it("cleans up and returns when an update crosses the nested TUI gate", async () => {
    withTuiAfterUpdateGate.mockResolvedValueOnce({ status: "updated" });
    const gateway = {} as never;
    const sessionGateway = { current: gateway };
    const closeSessionGateway = vi.fn(async () => {});

    await expect(
      runSetupTui({
        config: {},
        gatewayReachable: true,
        gatewayUrl: "ws://127.0.0.1:18789",
        sessionGateway,
        closeSessionGateway,
      }),
    ).resolves.toBeUndefined();

    expect(closeSessionGateway).toHaveBeenCalledWith(gateway);
    expect(sessionGateway.current).toBeUndefined();
  });
});
