import { describe, expect, it, vi } from "vitest";
import {
  resolveGatewayDevArgs,
  runGatewayDevMain,
} from "../../scripts/run-gateway-dev.mjs";

describe("scripts/run-gateway-dev", () => {
  it("adds dev gateway args and preserves extra flags", () => {
    expect(resolveGatewayDevArgs([])).toEqual(["--dev", "gateway"]);
    expect(resolveGatewayDevArgs(["--reset"])).toEqual(["--dev", "gateway", "--reset"]);
  });

  it("forces skip-channel env vars before delegating to runNodeMain", async () => {
    const runNodeMain = vi.fn(async () => 0);

    const exitCode = await runGatewayDevMain({
      args: ["--reset"],
      env: { PATH: "test-path", OPENCLAW_SKIP_CHANNELS: "0" },
      runNodeMain,
    });

    expect(exitCode).toBe(0);
    expect(runNodeMain).toHaveBeenCalledTimes(1);
    expect(runNodeMain).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--dev", "gateway", "--reset"],
        env: expect.objectContaining({
          PATH: "test-path",
          OPENCLAW_SKIP_CHANNELS: "1",
          CLAWDBOT_SKIP_CHANNELS: "1",
        }),
      }),
    );
  });
});
