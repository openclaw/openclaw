import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maybeSeedControlUiAllowedOriginsAtStartup", () => {
  it("persists origins seeded from runtime bind and port", async () => {
    const written: OpenClawConfig[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config: { gateway: {} },
      writeConfig: async (config) => {
        written.push(config);
      },
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    const expectedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
    expect(result.persistedAllowedOriginsSeed).toBe(true);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual(expectedOrigins);
    expect(written).toHaveLength(1);
    expect(written[0]?.gateway?.controlUi?.allowedOrigins).toEqual(expectedOrigins);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("for bind=lan"));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not rewrite config when origins already exist", async () => {
    const config: OpenClawConfig = {
      gateway: {
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    };
    const writeConfig = vi.fn<() => Promise<void>>();
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config,
      writeConfig,
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    expect(result).toEqual({ config, persistedAllowedOriginsSeed: false });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("merges explicit origins from env into seeded non-loopback origins", async () => {
    vi.stubEnv(
      "OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS",
      '["https://control.example.com", "http://control.example.com", "https://control.example.com"]',
    );
    const written: OpenClawConfig[] = [];
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = await maybeSeedControlUiAllowedOriginsAtStartup({
      config: { gateway: {} },
      writeConfig: async (config) => {
        written.push(config);
      },
      log,
      runtimeBind: "lan",
      runtimePort: 3000,
    });

    expect(result.persistedAllowedOriginsSeed).toBe(true);
    expect(result.config.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://control.example.com",
      "http://control.example.com",
    ]);
    expect(written).toHaveLength(1);
    expect(written[0]?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://control.example.com",
      "http://control.example.com",
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS"),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
