import { describe, expect, it } from "vitest";
import { extractConfigSummary } from "./helpers.js";

describe("extractConfigSummary", () => {
  it("marks SecretRef-backed gateway auth credentials as configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: {
        secrets: {
          defaults: {
            env: "default",
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
          },
          remote: {
            url: "wss://remote.example:18789",
            token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
            password: { source: "env", provider: "default", id: "REMOTE_GATEWAY_PASSWORD" },
          },
        },
      },
    });

    expect(summary.gateway.authTokenConfigured).toBe(true);
    expect(summary.gateway.authPasswordConfigured).toBe(true);
    expect(summary.gateway.remoteTokenConfigured).toBe(true);
    expect(summary.gateway.remotePasswordConfigured).toBe(true);
  });

  it("still treats empty plaintext auth values as not configured", () => {
    const summary = extractConfigSummary({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      legacyIssues: [],
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: "   ",
            password: "",
          },
          remote: {
            token: " ",
            password: "",
          },
        },
      },
    });

    expect(summary.gateway.authTokenConfigured).toBe(false);
    expect(summary.gateway.authPasswordConfigured).toBe(false);
    expect(summary.gateway.remoteTokenConfigured).toBe(false);
    expect(summary.gateway.remotePasswordConfigured).toBe(false);
  });
});
