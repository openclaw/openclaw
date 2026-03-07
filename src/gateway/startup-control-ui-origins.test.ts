import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  const noopLog = { info: vi.fn(), warn: vi.fn() };

  it("seeds allowedOrigins when CLI --bind lan is provided but config has no bind", async () => {
    const writeConfig = vi.fn();
    const config = { gateway: {} } as OpenClawConfig;
    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log: noopLog,
      bind: "lan",
    });
    // The seeded config should have allowedOrigins populated
    expect(result.gateway?.controlUi?.allowedOrigins).toBeDefined();
    expect(result.gateway?.controlUi?.allowedOrigins?.length).toBeGreaterThan(0);
    expect(writeConfig).toHaveBeenCalled();
  });

  it("does not seed when bind is loopback (default)", async () => {
    const writeConfig = vi.fn();
    const config = { gateway: {} } as OpenClawConfig;
    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log: noopLog,
    });
    expect(result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("does not seed when config already has allowedOrigins", async () => {
    const writeConfig = vi.fn();
    const config = {
      gateway: {
        bind: "lan",
        controlUi: { allowedOrigins: ["http://custom:18789"] },
      },
    } as OpenClawConfig;
    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log: noopLog,
      bind: "lan",
    });
    // Should keep original config with user-specified origins
    expect(result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });
});
