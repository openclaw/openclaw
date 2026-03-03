import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const callGateway = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway,
}));

const { resolveCommandSecretRefsViaGateway } = await import("./command-secret-gateway.js");

describe("resolveCommandSecretRefsViaGateway", () => {
  it("returns config unchanged when no target SecretRefs are configured", async () => {
    const config = {
      talk: {
        apiKey: "plain",
      },
    } as OpenClawConfig;
    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });
    expect(result.resolvedConfig).toEqual(config);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("skips gateway resolution when all configured target refs are inactive", async () => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              enabled: false,
              remote: {
                apiKey: { source: "env", provider: "default", id: "AGENT_MEMORY_API_KEY" },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "status",
      targetIds: new Set(["agents.list[].memorySearch.remote.apiKey"]),
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(result.resolvedConfig).toEqual(config);
    expect(result.diagnostics).toEqual([
      "agents.list.0.memorySearch.remote.apiKey: agent or memorySearch override is disabled.",
    ]);
  });

  it("hydrates requested SecretRef targets from gateway snapshot assignments", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.apiKey",
          pathSegments: ["talk", "apiKey"],
          value: "sk-live",
        },
      ],
      diagnostics: [],
    });
    const config = {
      talk: {
        apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
      },
    } as OpenClawConfig;
    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "secrets.resolve",
        requiredMethods: ["secrets.resolve"],
        params: {
          commandName: "memory status",
          targetIds: ["talk.apiKey"],
        },
      }),
    );
    expect(result.resolvedConfig.talk?.apiKey).toBe("sk-live");
  });

  it("fails fast when gateway-backed resolution is unavailable", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/failed to resolve secrets from the active gateway snapshot/i);
  });

  it("falls back to local resolution when gateway secrets.resolve is unavailable", async () => {
    process.env.TALK_API_KEY = "local-fallback-key";
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    const result = await resolveCommandSecretRefsViaGateway({
      config: {
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });
    delete process.env.TALK_API_KEY;

    expect(result.resolvedConfig.talk?.apiKey).toBe("local-fallback-key");
    expect(
      result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
    ).toBe(true);
  });

  it("returns a version-skew hint when gateway does not support secrets.resolve", async () => {
    callGateway.mockRejectedValueOnce(new Error("unknown method: secrets.resolve"));
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/does not support secrets\.resolve/i);
  });

  it("returns a version-skew hint when required-method capability check fails", async () => {
    callGateway.mockRejectedValueOnce(
      new Error(
        'active gateway does not support required method "secrets.resolve" for "secrets.resolve".',
      ),
    );
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/does not support secrets\.resolve/i);
  });

  it("fails when gateway returns an invalid secrets.resolve payload", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: "not-an-array",
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/invalid secrets\.resolve payload/i);
  });

  it("fails when gateway assignment path does not exist in local config", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.providers.elevenlabs.apiKey",
          pathSegments: ["talk", "providers", "elevenlabs", "apiKey"],
          value: "sk-live",
        },
      ],
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/Path segment does not exist/i);
  });

  it("fails when configured refs remain unresolved after gateway assignments are applied", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });

    await expect(
      resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        } as OpenClawConfig,
        commandName: "memory status",
        targetIds: new Set(["talk.apiKey"]),
      }),
    ).rejects.toThrow(/talk\.apiKey is unresolved in the active runtime snapshot/i);
  });

  it("allows unresolved refs when gateway diagnostics mark the target as inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [
        "talk.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
      ],
    });

    const result = await resolveCommandSecretRefsViaGateway({
      config: {
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      } as OpenClawConfig,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });

    expect(result.resolvedConfig.talk?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    expect(result.diagnostics).toEqual([
      "talk.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
    ]);
  });

  it("uses inactiveRefPaths from structured response without parsing diagnostic text", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: ["talk api key inactive"],
      inactiveRefPaths: ["talk.apiKey"],
    });

    const result = await resolveCommandSecretRefsViaGateway({
      config: {
        talk: {
          apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
        },
      } as OpenClawConfig,
      commandName: "memory status",
      targetIds: new Set(["talk.apiKey"]),
    });

    expect(result.resolvedConfig.talk?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });
    expect(result.diagnostics).toEqual(["talk api key inactive"]);
  });

  it("allows unresolved array-index refs when gateway marks concrete paths inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: ["memory search ref inactive"],
      inactiveRefPaths: ["agents.list.0.memorySearch.remote.apiKey"],
    });

    const config = {
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              remote: {
                apiKey: { source: "env", provider: "default", id: "MISSING_MEMORY_API_KEY" },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "memory status",
      targetIds: new Set(["agents.list[].memorySearch.remote.apiKey"]),
    });

    expect(result.resolvedConfig.agents?.list?.[0]?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_MEMORY_API_KEY",
    });
    expect(result.diagnostics).toEqual(["memory search ref inactive"]);
  });
});
