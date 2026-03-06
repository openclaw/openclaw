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
    const envKey = "TALK_API_KEY_FAILFAST";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    try {
      await expect(
        resolveCommandSecretRefsViaGateway({
          config: {
            talk: {
              apiKey: { source: "env", provider: "default", id: envKey },
            },
          } as OpenClawConfig,
          commandName: "memory status",
          targetIds: new Set(["talk.apiKey"]),
        }),
      ).rejects.toThrow(/failed to resolve secrets from the active gateway snapshot/i);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });

  it("falls back to local resolution when gateway secrets.resolve is unavailable", async () => {
    const priorValue = process.env.TALK_API_KEY;
    process.env.TALK_API_KEY = "local-fallback-key";
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    try {
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

      expect(result.resolvedConfig.talk?.apiKey).toBe("local-fallback-key");
      expect(
        result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
      ).toBe(true);
      expect(
        result.diagnostics.some((entry) => entry.includes("resolved command secrets locally")),
      ).toBe(true);
    } finally {
      if (priorValue === undefined) {
        delete process.env.TALK_API_KEY;
      } else {
        process.env.TALK_API_KEY = priorValue;
      }
    }
  });

  it("returns a version-skew hint when gateway does not support secrets.resolve", async () => {
    const envKey = "TALK_API_KEY_UNSUPPORTED";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(new Error("unknown method: secrets.resolve"));
    try {
      await expect(
        resolveCommandSecretRefsViaGateway({
          config: {
            talk: {
              apiKey: { source: "env", provider: "default", id: envKey },
            },
          } as OpenClawConfig,
          commandName: "memory status",
          targetIds: new Set(["talk.apiKey"]),
        }),
      ).rejects.toThrow(/does not support secrets\.resolve/i);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });

  it("returns a version-skew hint when required-method capability check fails", async () => {
    const envKey = "TALK_API_KEY_REQUIRED_METHOD";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(
      new Error(
        'active gateway does not support required method "secrets.resolve" for "secrets.resolve".',
      ),
    );
    try {
      await expect(
        resolveCommandSecretRefsViaGateway({
          config: {
            talk: {
              apiKey: { source: "env", provider: "default", id: envKey },
            },
          } as OpenClawConfig,
          commandName: "memory status",
          targetIds: new Set(["talk.apiKey"]),
        }),
      ).rejects.toThrow(/does not support secrets\.resolve/i);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
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

  it("degrades unresolved refs in summary mode instead of throwing", async () => {
    const envKey = "TALK_API_KEY_SUMMARY_MISSING";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: envKey },
          },
        } as OpenClawConfig,
        commandName: "status",
        targetIds: new Set(["talk.apiKey"]),
        mode: "summary",
      });

      expect(result.resolvedConfig.talk?.apiKey).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("unresolved");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes("talk.apiKey is unavailable in this command path"),
        ),
      ).toBe(true);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });

  it("uses targeted local fallback after an incomplete gateway snapshot", async () => {
    const envKey = "TALK_API_KEY_PARTIAL_GATEWAY";
    const priorValue = process.env[envKey];
    process.env[envKey] = "recovered-locally";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: envKey },
          },
        } as OpenClawConfig,
        commandName: "status",
        targetIds: new Set(["talk.apiKey"]),
        mode: "summary",
      });

      expect(result.resolvedConfig.talk?.apiKey).toBe("recovered-locally");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("resolved_local");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes(
            "resolved 1 secret path locally after the gateway snapshot was incomplete",
          ),
        ),
      ).toBe(true);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });

  it("limits strict local fallback analysis to unresolved gateway paths", async () => {
    const gatewayResolvedKey = "TALK_API_KEY_PARTIAL_GATEWAY_RESOLVED";
    const locallyRecoveredKey = "TALK_API_KEY_PARTIAL_GATEWAY_LOCAL";
    const priorGatewayResolvedValue = process.env[gatewayResolvedKey];
    const priorLocallyRecoveredValue = process.env[locallyRecoveredKey];
    delete process.env[gatewayResolvedKey];
    process.env[locallyRecoveredKey] = "recovered-locally";
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.apiKey",
          pathSegments: ["talk", "apiKey"],
          value: "resolved-by-gateway",
        },
      ],
      diagnostics: [],
    });

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: gatewayResolvedKey },
            providers: {
              elevenlabs: {
                apiKey: { source: "env", provider: "default", id: locallyRecoveredKey },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "message send",
        targetIds: new Set(["talk.apiKey", "talk.providers.*.apiKey"]),
      });

      expect(result.resolvedConfig.talk?.apiKey).toBe("resolved-by-gateway");
      expect(result.resolvedConfig.talk?.providers?.elevenlabs?.apiKey).toBe("recovered-locally");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("resolved_gateway");
      expect(result.targetStatesByPath["talk.providers.elevenlabs.apiKey"]).toBe("resolved_local");
    } finally {
      if (priorGatewayResolvedValue === undefined) {
        delete process.env[gatewayResolvedKey];
      } else {
        process.env[gatewayResolvedKey] = priorGatewayResolvedValue;
      }
      if (priorLocallyRecoveredValue === undefined) {
        delete process.env[locallyRecoveredKey];
      } else {
        process.env[locallyRecoveredKey] = priorLocallyRecoveredValue;
      }
    }
  });

  it("limits local fallback to targeted refs in read-only modes", async () => {
    const talkEnvKey = "TALK_API_KEY_TARGET_ONLY";
    const gatewayEnvKey = "GATEWAY_PASSWORD_UNRELATED";
    const priorTalkValue = process.env[talkEnvKey];
    const priorGatewayValue = process.env[gatewayEnvKey];
    process.env[talkEnvKey] = "target-only";
    delete process.env[gatewayEnvKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: talkEnvKey },
          },
          gateway: {
            auth: {
              password: { source: "env", provider: "default", id: gatewayEnvKey },
            },
          },
        } as OpenClawConfig,
        commandName: "status",
        targetIds: new Set(["talk.apiKey"]),
        mode: "summary",
      });

      expect(result.resolvedConfig.talk?.apiKey).toBe("target-only");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("resolved_local");
    } finally {
      if (priorTalkValue === undefined) {
        delete process.env[talkEnvKey];
      } else {
        process.env[talkEnvKey] = priorTalkValue;
      }
      if (priorGatewayValue === undefined) {
        delete process.env[gatewayEnvKey];
      } else {
        process.env[gatewayEnvKey] = priorGatewayValue;
      }
    }
  });

  it("degrades unresolved refs in operational read-only mode", async () => {
    const envKey = "TALK_API_KEY_OPERATIONAL_MISSING";
    const priorValue = process.env[envKey];
    delete process.env[envKey];
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));

    try {
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          talk: {
            apiKey: { source: "env", provider: "default", id: envKey },
          },
        } as OpenClawConfig,
        commandName: "channels resolve",
        targetIds: new Set(["talk.apiKey"]),
        mode: "operational_readonly",
      });

      expect(result.resolvedConfig.talk?.apiKey).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("unresolved");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes("attempted local command-secret resolution"),
        ),
      ).toBe(true);
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  });
});
