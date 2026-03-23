import { describe, expect, it, vi } from "vitest";
import { runLoggedGatewayStartupPhase } from "./server-startup-phase-log.js";

describe("runLoggedGatewayStartupPhase", () => {
  it("logs start and completion for fast phases", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const result = await runLoggedGatewayStartupPhase({
      phase: "transport_bootstrap",
      log: { info, warn },
      run: async () => "ok",
      slowAfterMs: 1_000,
    });

    expect(result).toBe("ok");
    expect(info).toHaveBeenCalledWith("[phase:transport_bootstrap] starting");
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/completed in \d+ms/));
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a phase exceeds the slow threshold", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await runLoggedGatewayStartupPhase({
      phase: "plugin_bootstrap",
      log: { info, warn },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "ok";
      },
      slowAfterMs: 1,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/plugin_bootstrap.*completed in \d+ms/),
    );
  });

  it("logs failure duration before rethrowing", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await expect(
      runLoggedGatewayStartupPhase({
        phase: "runtime_config_resolution",
        log: { info, warn },
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\[phase:runtime_config_resolution\] failed after \d+ms: boom/),
    );
  });
});
