import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

const { callGateway } = mocks;

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../secrets/runtime-web-tools.js", () => ({
  resolveRuntimeWebTools: vi.fn(async () => ({})),
}));

vi.mock("../utils/message-channel.js", () => ({
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

beforeEach(() => {
  callGateway.mockReset();
});

describe("resolveCommandSecretRefsViaGateway", () => {
  function makeTalkApiKeySecretRefConfig(envKey: string): OpenClawConfig {
    return {
      talk: {
        apiKey: { source: "env", provider: "default", id: envKey },
      },
    } as OpenClawConfig;
  }

  async function withEnvValue(
    envKey: string,
    value: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    const priorValue = process.env[envKey];
    if (value === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = value;
    }
    try {
      await fn();
    } finally {
      if (priorValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = priorValue;
      }
    }
  }

  async function resolveTalkApiKey(params: {
    envKey: string;
    commandName?: string;
    mode?: "enforce_resolved" | "read_only_status";
  }) {
    return resolveCommandSecretRefsViaGateway({
      config: makeTalkApiKeySecretRefConfig(params.envKey),
      commandName: params.commandName ?? "memory status",
      targetIds: new Set(["talk.apiKey"]),
      mode: params.mode,
    });
  }

  function expectTalkApiKeySecretRef(
    result: Awaited<ReturnType<typeof resolveTalkApiKey>>,
    envKey: string,
  ) {
    expect(result.resolvedConfig.talk?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: envKey,
    });
  }

  function expectGatewayUnavailableLocalFallbackDiagnostics(
    result: Awaited<ReturnType<typeof resolveCommandSecretRefsViaGateway>>,
  ) {
    expect(
      result.diagnostics.some((entry) => entry.includes("gateway secrets.resolve unavailable")),
    ).toBe(true);
    expect(
      result.diagnostics.some((entry) => entry.includes("resolved command secrets locally")),
    ).toBe(true);
  }

  it("returns config unchanged when no target SecretRefs are configured", async () => {
    const config = {
      talk: {
        apiKey: "plain", // pragma: allowlist secret
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
        config,
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

  it("enforces unresolved checks only for allowed paths when provided", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "channels.discord.accounts.ops.token",
          pathSegments: ["channels", "discord", "accounts", "ops", "token"],
          value: "ops-token",
        },
      ],
      diagnostics: [],
    });

    const result = await resolveCommandSecretRefsViaGateway({
      config: {
        channels: {
          discord: {
            accounts: {
              ops: {
                token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
              },
              chat: {
                token: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
              },
            },
          },
        },
      } as OpenClawConfig,
      commandName: "message",
      targetIds: new Set(["channels.discord.accounts.*.token"]),
      allowedPaths: new Set(["channels.discord.accounts.ops.token"]),
    });

    expect(result.resolvedConfig.channels?.discord?.accounts?.ops?.token).toBe("ops-token");
    expect(result.targetStatesByPath).toEqual({
      "channels.discord.accounts.ops.token": "resolved_gateway",
    });
    expect(result.hadUnresolvedTargets).toBe(false);
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
    process.env.TALK_API_KEY = "local-fallback-key"; // pragma: allowlist secret
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

  it("falls back to local resolution for web search SecretRefs when gateway is unavailable", async () => {
    const envKey = "WEB_SEARCH_GEMINI_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "gemini-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          plugins: {
            entries: {
              google: {
                config: {
                  webSearch: {
                    apiKey: { source: "env", provider: "default", id: envKey },
                  },
                },
              },
            },
          },
          tools: {
            web: {
              search: {
                provider: "gemini",
              },
            },
          },
        } as OpenClawConfig,
        commandName: "agent",
        targetIds: new Set(["plugins.entries.google.config.webSearch.apiKey"]),
      });

      const googleWebSearchConfig = result.resolvedConfig.plugins?.entries?.google?.config as
        | { webSearch?: { apiKey?: unknown } }
        | undefined;
      expect(googleWebSearchConfig?.webSearch?.apiKey).toBe("gemini-local-fallback-key");
      expect(result.targetStatesByPath["plugins.entries.google.config.webSearch.apiKey"]).toBe(
        "resolved_local",
      );
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  }, 300_000);

  it("falls back to local resolution for Firecrawl SecretRefs when gateway is unavailable", async () => {
    const envKey = "WEB_FETCH_FIRECRAWL_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "firecrawl-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          tools: {
            web: {
              fetch: {
                firecrawl: {
                  apiKey: { source: "env", provider: "default", id: envKey },
                },
              },
            },
          },
        } as OpenClawConfig,
        commandName: "agent",
        targetIds: new Set(["tools.web.fetch.firecrawl.apiKey"]),
      });

      expect(result.resolvedConfig.tools?.web?.fetch?.firecrawl?.apiKey).toBe(
        "firecrawl-local-fallback-key",
      );
      expect(result.targetStatesByPath["tools.web.fetch.firecrawl.apiKey"]).toBe("resolved_local");
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("marks web SecretRefs inactive when the web surface is disabled during local fallback", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    const result = await resolveCommandSecretRefsViaGateway({
      config: {
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_DISABLED_KEY",
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      commandName: "agent",
      targetIds: new Set(["plugins.entries.google.config.webSearch.apiKey"]),
    });

    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath["plugins.entries.google.config.webSearch.apiKey"]).toBe(
      "inactive_surface",
    );
    expect(
      result.diagnostics.some((entry) =>
        entry.includes(
          "plugins.entries.google.config.webSearch.apiKey: tools.web.search is disabled.",
        ),
      ),
    ).toBe(true);
  });

  it("returns a version-skew hint when gateway does not support secrets.resolve", async () => {
    const envKey = "TALK_API_KEY_UNSUPPORTED";
    callGateway.mockRejectedValueOnce(new Error("unknown method: secrets.resolve"));
    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkApiKey({ envKey })).rejects.toThrow(
        /does not support secrets\.resolve/i,
      );
    });
  });

  it("returns a version-skew hint when required-method capability check fails", async () => {
    const envKey = "TALK_API_KEY_REQUIRED_METHOD";
    callGateway.mockRejectedValueOnce(
      new Error(
        'active gateway does not support required method "secrets.resolve" for "secrets.resolve".',
      ),
    );
    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkApiKey({ envKey })).rejects.toThrow(
        /does not support secrets\.resolve/i,
      );
    });
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
    const envKey = "TALK_API_KEY_STRICT_UNRESOLVED";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });

    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkApiKey({ envKey })).rejects.toThrow(
        /talk\.apiKey is unresolved in the active runtime snapshot/i,
      );
    });
  });

  it("allows unresolved refs when gateway diagnostics mark the target as inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [
        "talk.apiKey: secret ref is configured on an inactive surface; skipping command-time assignment.",
      ],
    });

    const result = await resolveTalkApiKey({ envKey: "TALK_API_KEY" });

    expectTalkApiKeySecretRef(result, "TALK_API_KEY");
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

    const result = await resolveTalkApiKey({ envKey: "TALK_API_KEY" });

    expectTalkApiKeySecretRef(result, "TALK_API_KEY");
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

  it("degrades unresolved refs in read-only status mode instead of throwing", async () => {
    const envKey = "TALK_API_KEY_SUMMARY_MISSING";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, undefined, async () => {
      const result = await resolveTalkApiKey({
        envKey,
        commandName: "status",
        mode: "read_only_status",
      });
      expect(result.resolvedConfig.talk?.apiKey).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("unresolved");
      expect(
        result.diagnostics.some((entry) =>
          entry.includes("talk.apiKey is unavailable in this command path"),
        ),
      ).toBe(true);
    });
  });

  it("accepts legacy summary mode as a read-only alias", async () => {
    const envKey = "TALK_API_KEY_LEGACY_SUMMARY_MISSING";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, undefined, async () => {
      const result = await resolveCommandSecretRefsViaGateway({
        config: makeTalkApiKeySecretRefConfig(envKey),
        commandName: "status",
        targetIds: new Set(["talk.apiKey"]),
        mode: "summary",
      });
      expect(result.resolvedConfig.talk?.apiKey).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath["talk.apiKey"]).toBe("unresolved");
    });
  });

  it("uses targeted local fallback after an incomplete gateway snapshot", async () => {
    const envKey = "TALK_API_KEY_PARTIAL_GATEWAY";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, "recovered-locally", async () => {
      const result = await resolveTalkApiKey({
        envKey,
        commandName: "status",
        mode: "read_only_status",
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
    });
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
        mode: "read_only_status",
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

  it("degrades unresolved refs in read-only operational mode", async () => {
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
        mode: "read_only_operational",
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
