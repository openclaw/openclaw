// Startup warns once about ignored legacy prefixes without leaking names or values.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolveGatewayRuntimeConfig: typeof import("./server-runtime-config.js").resolveGatewayRuntimeConfig;

function resolve() {
  return resolveGatewayRuntimeConfig({
    cfg: { gateway: { bind: "loopback", auth: { mode: "none" } } },
    port: 18789,
    host: "127.0.0.1",
  });
}

describe("Gateway legacy environment warning", () => {
  let emitWarning: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    ({ resolveGatewayRuntimeConfig } = await import("./server-runtime-config.js"));
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
      vi.stubEnv(key, undefined);
    }
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CLAWDBOT_") || key.startsWith("MOLTBOT_")) {
        vi.stubEnv(key, undefined);
      }
    }
  });

  afterEach(() => {
    emitWarning.mockRestore();
    vi.unstubAllEnvs();
  });

  it("warns with counts and prefixes instead of secret-shaped env names", async () => {
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "old-token");
    vi.stubEnv("MOLTBOT_GATEWAY_PASSWORD", "old-password");
    vi.stubEnv("CLAWDBOT_MALICIOUS\nforged", "old-value");
    await resolve();

    expect(emitWarning).toHaveBeenCalledOnce();
    const [message, options] = emitWarning.mock.calls.at(0) ?? [];
    expect(message).toContain("Legacy CLAWDBOT_*, MOLTBOT_* environment variables");
    expect(message).toContain("3 total");
    expect(message).toContain("replacing the legacy prefix with OPENCLAW_");
    expect(message).not.toContain("GATEWAY_TOKEN");
    expect(message).not.toContain("GATEWAY_PASSWORD");
    expect(message).not.toContain("forged");
    expect(options).toEqual({
      code: "OPENCLAW_LEGACY_ENV_VARS",
      type: "DeprecationWarning",
    });
  });

  it("does not warn for current OPENCLAW names", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "token");
    await resolve();

    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("warns only once after a successful emit", async () => {
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "old-token");
    await resolve();
    vi.stubEnv("MOLTBOT_GATEWAY_TOKEN", "old-token");
    await resolve();

    expect(emitWarning).toHaveBeenCalledOnce();
  });

  it("suppresses warning noise in a test environment", async () => {
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "old-token");
    vi.stubEnv("VITEST", "true");
    await resolve();

    expect(emitWarning).not.toHaveBeenCalled();
  });
});
