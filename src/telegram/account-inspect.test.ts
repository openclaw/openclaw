import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { inspectTelegramAccount } from "./account-inspect.js";

describe("inspectTelegramAccount", () => {
  it("returns configured=true for exec SecretRef botToken without throwing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "my_provider", id: "telegram/apiKey" },
        },
      },
    } as unknown as OpenClawConfig;

    const result = inspectTelegramAccount({ cfg });
    expect(result.configured).toBe(true);
    expect(result.tokenStatus).toBe("configured_unavailable");
    expect(result.token).toBe("");
    vi.unstubAllEnvs();
  });

  it("returns configured=true for env SecretRef botToken without throwing", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;

    const result = inspectTelegramAccount({ cfg });
    expect(result.configured).toBe(true);
    expect(result.tokenStatus).toBe("configured_unavailable");
    expect(result.token).toBe("");
    vi.unstubAllEnvs();
  });

  it("returns available token for plain string botToken", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: { telegram: { botToken: "plain-token" } },
    } as OpenClawConfig;

    const result = inspectTelegramAccount({ cfg });
    expect(result.configured).toBe(true);
    expect(result.tokenStatus).toBe("available");
    expect(result.token).toBe("plain-token");
    vi.unstubAllEnvs();
  });

  it("returns configured=false when no token is set", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;

    const result = inspectTelegramAccount({ cfg });
    expect(result.configured).toBe(false);
    expect(result.tokenStatus).toBe("missing");
    vi.unstubAllEnvs();
  });
});
