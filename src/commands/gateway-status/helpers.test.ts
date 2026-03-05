import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { extractConfigSummary, resolveAuthForTarget } from "./helpers.js";

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

describe("resolveAuthForTarget", () => {
  it("resolves local auth token SecretRef before probing local targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        LOCAL_GATEWAY_TOKEN: "resolved-local-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                token: { source: "env", provider: "default", id: "LOCAL_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "localLoopback",
            kind: "localLoopback",
            url: "ws://127.0.0.1:18789",
            active: true,
          },
          {},
        );

        expect(auth).toEqual({ token: "resolved-local-token", password: undefined });
      },
    );
  });

  it("resolves remote auth token SecretRef before probing remote targets", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              remote: {
                token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "configRemote",
            kind: "configRemote",
            url: "wss://remote.example:18789",
            active: true,
          },
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("resolves remote auth even when local auth mode is none", async () => {
    await withEnvAsync(
      {
        REMOTE_GATEWAY_TOKEN: "resolved-remote-token",
      },
      async () => {
        const auth = await resolveAuthForTarget(
          {
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
            gateway: {
              auth: {
                mode: "none",
              },
              remote: {
                token: { source: "env", provider: "default", id: "REMOTE_GATEWAY_TOKEN" },
              },
            },
          },
          {
            id: "configRemote",
            kind: "configRemote",
            url: "wss://remote.example:18789",
            active: true,
          },
          {},
        );

        expect(auth).toEqual({ token: "resolved-remote-token", password: undefined });
      },
    );
  });

  it("does not force remote auth type from local auth mode", async () => {
    const auth = await resolveAuthForTarget(
      {
        gateway: {
          auth: {
            mode: "password",
          },
          remote: {
            token: "remote-token",
            password: "remote-password",
          },
        },
      },
      {
        id: "configRemote",
        kind: "configRemote",
        url: "wss://remote.example:18789",
        active: true,
      },
      {},
    );

    expect(auth).toEqual({ token: "remote-token", password: undefined });
  });
});
