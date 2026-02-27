import { describe, expect, it } from "vitest";
import { resolveGatewayAuth } from "./auth.js";

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    }
  }
}

describe("resolveGatewayAuth env aliases", () => {
  it("accepts MOLTBOT_GATEWAY_TOKEN as legacy alias", () => {
    const auth = withEnv(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        CLAWDBOT_GATEWAY_TOKEN: undefined,
        MOLTBOT_GATEWAY_TOKEN: "moltworker-secret",
      },
      () => resolveGatewayAuth({ authConfig: { mode: "token" } }),
    );

    expect(auth.mode).toBe("token");
    expect(auth.token).toBe("moltworker-secret");
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN over legacy aliases", () => {
    const auth = withEnv(
      {
        OPENCLAW_GATEWAY_TOKEN: "openclaw-secret",
        MOLTBOT_GATEWAY_TOKEN: "moltworker-secret",
        CLAWDBOT_GATEWAY_TOKEN: "clawdbot-secret",
      },
      () => resolveGatewayAuth({ authConfig: { mode: "token" } }),
    );

    expect(auth.token).toBe("openclaw-secret");
  });
});
