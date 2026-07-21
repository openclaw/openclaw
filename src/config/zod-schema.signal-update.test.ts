// Signal schema update tests cover the bounded post-core migration validation window.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Signal post-core update schema", () => {
  const legacyConfig = {
    account: "+15555550123",
    apiMode: "container",
    httpUrl: "http://signal-container:8080",
    autoStart: false,
  };

  it("accepts shipped transport fields only while update finalization owns migration", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.resetModules();
    const { SignalConfigSchema } = await import("./zod-schema.providers-core.js");

    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(true);
  });

  it("keeps normal runtime validation canonical", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    vi.resetModules();
    const { SignalConfigSchema } = await import("./zod-schema.providers-core.js");

    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(false);
  });

  it("closes the temporary schema window without reloading modules", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.resetModules();
    const { SignalConfigSchema } = await import("./zod-schema.providers-core.js");

    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(true);
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "0");
    expect(SignalConfigSchema.safeParse(legacyConfig).success).toBe(false);
  });
});
