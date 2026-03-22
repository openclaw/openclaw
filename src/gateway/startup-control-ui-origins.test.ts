import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function mockWriteConfig() {
  return vi.fn(async (_config: OpenClawConfig) => {});
}

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  it("seeds origins when CLI --bind lan overrides a config with no bind set", async () => {
    const config: OpenClawConfig = { gateway: { port: 3000 } };
    const writeConfig = mockWriteConfig();
    const log = makeLog();

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log,
      bindOverride: "lan",
    });

    expect(result.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
    expect(writeConfig).toHaveBeenCalledOnce();
    // The persisted config should NOT contain bind=lan (CLI override stays transient).
    expect(writeConfig.mock.calls[0][0].gateway?.bind).toBeUndefined();
    expect(log.info).toHaveBeenCalledOnce();
  });

  it("does not seed when config already has allowedOrigins", async () => {
    const config: OpenClawConfig = {
      gateway: {
        bind: "lan",
        port: 3000,
        controlUi: { allowedOrigins: ["https://example.com"] },
      },
    };
    const writeConfig = mockWriteConfig();
    const log = makeLog();

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log,
      bindOverride: "lan",
    });

    expect(result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("does not seed when bind is loopback (no override)", async () => {
    const config: OpenClawConfig = { gateway: { port: 3000 } };
    const writeConfig = mockWriteConfig();
    const log = makeLog();

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log,
    });

    expect(result).toBe(config);
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("returns seeded origins even when writeConfig fails", async () => {
    const config: OpenClawConfig = { gateway: { port: 4000 } };
    const writeConfig = vi.fn(async (_config: OpenClawConfig) => {
      throw new Error("read-only fs");
    });
    const log = makeLog();

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log,
      bindOverride: "lan",
    });

    expect(result.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:4000",
      "http://127.0.0.1:4000",
    ]);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
