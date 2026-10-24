import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import {
  getAuthoredConfigSecretRef,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry-contributions.js";
import { analyzeCommandSecretAssignmentsFromSnapshot } from "../secrets/command-config.js";
import { collectConfigAssignments as collectRuntimeConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { withSecureTestNodeExecPath } from "../secrets/test-node-command.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  buildTalkTestProviderConfig,
  readTalkTestProviderApiKey as readTalkProviderApiKey,
  TALK_TEST_PROVIDER_API_KEY_PATH,
} from "../test-utils/talk-test-provider.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

const { callGateway } = mocks;
const tempRoots = new Set<string>();

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../secrets/runtime-web-tools.js", () => ({
  resolveRuntimeWebTools: vi.fn(async () => ({
    metadata: {
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    },
    degradedOwners: [],
  })),
}));

vi.mock("../utils/message-channel.js", () => ({
  GATEWAY_CLIENT_MODES: { CLI: "cli" },
  GATEWAY_CLIENT_NAMES: { CLI: "cli" },
}));

vi.mock("../secrets/command-config.js", { spy: true });
vi.mock("../secrets/runtime-config-collectors.js", { spy: true });
vi.mock("../secrets/target-registry-query.js", { spy: true });
vi.mock("../plugins/plugin-registry-contributions.js", { spy: true });

function resetCommandSecretMocks(): void {
  vi.mocked(analyzeCommandSecretAssignmentsFromSnapshot).mockReset();
  vi.mocked(collectRuntimeConfigAssignments).mockReset();
  vi.mocked(discoverConfigSecretTargetsByIds).mockReset();
  vi.mocked(resolveManifestContractOwnerPluginId).mockReset();
}

beforeEach(() => {
  callGateway.mockReset();
  resetCommandSecretMocks();
});

afterEach(async () => {
  resetCommandSecretMocks();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("resolveCommandSecretRefsViaGateway", () => {
  const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
  function webConfig(
    plugin: string,
    credential: "webSearch" | "webFetch",
    id: string,
    web: NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>,
    enabled?: boolean,
  ): OpenClawConfig {
    return {
      tools: { web },
      plugins: {
        entries: { [plugin]: { enabled, config: { [credential]: { apiKey: secretRef(id) } } } },
      },
    };
  }

  function expectDiagnostic(result: { diagnostics: string[] }, text: string) {
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining(text)]));
  }

  function makeTalkProviderApiKeySecretRefConfig(envKey: string): OpenClawConfig {
    return buildTalkTestProviderConfig({ source: "env", provider: "default", id: envKey });
  }

  async function withEnvValue(
    envKey: string,
    value: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    await withEnvAsync({ [envKey]: value }, fn);
  }

  async function resolveTalkProviderApiKey(params: {
    envKey: string;
    commandName?: string;
    mode?: "enforce_resolved" | "read_only_status";
  }) {
    return resolveCommandSecretRefsViaGateway({
      config: makeTalkProviderApiKeySecretRefConfig(params.envKey),
      commandName: params.commandName ?? "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      mode: params.mode,
    });
  }

  function expectTalkProviderApiKeySecretRef(
    result: Awaited<ReturnType<typeof resolveTalkProviderApiKey>>,
    envKey: string,
  ) {
    expect(readTalkProviderApiKey(result.resolvedConfig)).toEqual({
      source: "env",
      provider: "default",
      id: envKey,
    });
  }

  function expectGatewayUnavailableLocalFallbackDiagnostics(
    result: Awaited<ReturnType<typeof resolveCommandSecretRefsViaGateway>>,
  ) {
    expectDiagnostic(result, "gateway secrets.resolve unavailable");
    expectDiagnostic(result, "resolved command secrets locally");
  }

  async function createExecProviderConfig(refId: string): Promise<{
    config: OpenClawConfig;
    markerPath: string;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-command-secret-exec-"));
    tempRoots.add(root);
    const markerPath = path.join(root, "executed");
    const resolverScript = [
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(stdin);",
      "  fs.writeFileSync(process.env.OPENCLAW_EXEC_MARKER, 'executed');",
      "  const values = Object.fromEntries(request.ids.map((id) => [id, 'exec-local-key']));",
      "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
      "});",
    ].join("\n");
    return {
      markerPath,
      config: {
        ...buildTalkTestProviderConfig({
          source: "exec",
          provider: "default",
          id: refId,
        }),
        secrets: {
          providers: {
            default: {
              source: "exec",
              command: process.execPath,
              args: ["-e", resolverScript],
              env: { OPENCLAW_EXEC_MARKER: markerPath },
              allowInsecurePath: true,
              allowSymlinkCommand: true,
              jsonOnly: true,
            },
          },
        },
      } as OpenClawConfig,
    };
  }

  async function markerExists(markerPath: string): Promise<boolean> {
    return await fs.access(markerPath).then(
      () => true,
      () => false,
    );
  }

  function readPath(root: unknown, pathSegments: readonly string[]): unknown {
    let cursor = root;
    for (const segment of pathSegments) {
      if (!cursor || typeof cursor !== "object") {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  }

  function setSingleSecretTargetDeps(params: {
    path: string;
    pathSegments: readonly string[];
    collectConfigAssignments?: typeof collectRuntimeConfigAssignments;
    resolveManifestContractOwnerPluginId?: typeof resolveManifestContractOwnerPluginId;
  }): void {
    vi.mocked(analyzeCommandSecretAssignmentsFromSnapshot).mockImplementation(
      ({ inactiveRefPaths, resolvedConfig }) => {
        const value = readPath(resolvedConfig, params.pathSegments);
        const resolved = typeof value === "string" && value.length > 0;
        const inactive = Boolean(inactiveRefPaths?.has(params.path));
        const target = { path: params.path, pathSegments: [...params.pathSegments] };
        return {
          assignments: resolved ? [{ ...target, value }] : [],
          diagnostics: [],
          inactive: inactive ? [target] : [],
          unresolved: resolved || inactive ? [] : [target],
        } as never;
      },
    );
    vi.mocked(collectRuntimeConfigAssignments).mockImplementation(
      params.collectConfigAssignments ??
        (async ({ context }) => {
          context.assignments.push({ path: params.path } as never);
        }),
    );
    vi.mocked(discoverConfigSecretTargetsByIds).mockImplementation(
      (config) =>
        [
          {
            entry: { expectedResolvedValue: "string" },
            path: params.path,
            pathSegments: [...params.pathSegments],
            value: readPath(config, params.pathSegments),
          },
        ] as never,
    );
    if (params.resolveManifestContractOwnerPluginId) {
      vi.mocked(resolveManifestContractOwnerPluginId).mockImplementation(
        params.resolveManifestContractOwnerPluginId,
      );
    }
  }

  function setDiscordAccountTargetDeps(): void {
    vi.mocked(analyzeCommandSecretAssignmentsFromSnapshot).mockImplementation(
      () =>
        ({
          assignments: [
            {
              path: "channels.discord.accounts.ops.token",
              pathSegments: ["channels", "discord", "accounts", "ops", "token"],
              value: "ops-token",
            },
          ],
          diagnostics: [],
          inactive: [],
          unresolved: [],
        }) as never,
    );
    vi.mocked(collectRuntimeConfigAssignments).mockImplementation(async ({ context }) => {
      context.assignments.push(
        { path: "channels.discord.accounts.ops.token" } as never,
        { path: "channels.discord.accounts.chat.token" } as never,
      );
    });
    vi.mocked(discoverConfigSecretTargetsByIds).mockImplementation(
      () =>
        [
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.ops.token",
            pathSegments: ["channels", "discord", "accounts", "ops", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" },
          },
          {
            entry: { expectedResolvedValue: "string" },
            path: "channels.discord.accounts.chat.token",
            pathSegments: ["channels", "discord", "accounts", "chat", "token"],
            value: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" },
          },
        ] as never,
    );
  }

  function setFirecrawlWebSearchTargetDeps(): void {
    setSingleSecretTargetDeps({
      path: "plugins.entries.firecrawl.config.webSearch.apiKey",
      pathSegments: ["plugins", "entries", "firecrawl", "config", "webSearch", "apiKey"],
    });
  }

  function setFirecrawlWebFetchTargetDeps(): void {
    setSingleSecretTargetDeps({
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
      pathSegments: ["plugins", "entries", "firecrawl", "config", "webFetch", "apiKey"],
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webFetchProviders" && params.value === "firecrawl"
          ? "firecrawl"
          : undefined,
    });
  }

  function setGoogleWebSearchTargetDeps(): void {
    setSingleSecretTargetDeps({
      path: "plugins.entries.google.config.webSearch.apiKey",
      pathSegments: ["plugins", "entries", "google", "config", "webSearch", "apiKey"],
      resolveManifestContractOwnerPluginId: (params) =>
        params.contract === "webSearchProviders" && params.value === "gemini"
          ? "google"
          : undefined,
    });
  }

  it("skips gateway resolution when all configured target refs are inactive", async () => {
    const config = {
      agents: {
        entries: {
          main: {
            memory: {
              search: {
                enabled: false,
                remote: {
                  apiKey: { source: "env", provider: "default", id: "AGENT_MEMORY_API_KEY" },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "status",
      targetIds: new Set(["agents.entries.*.memory.search.remote.apiKey"]),
    });

    expect(callGateway).not.toHaveBeenCalled();
    expect(result.resolvedConfig).toEqual(config);
    expect(result.diagnostics).toEqual([
      "agents.entries.main.memory.search.remote.apiKey: agent or memorySearch override is disabled.",
    ]);
  });

  it("applies and clears a numeric object key instead of the display path", async () => {
    const input = { talk: { providers: { "0": { apiKey: "${SOURCE_KEY}" } } } };
    const targetPath = 'talk.providers["0"].apiKey';
    const pathSegments = ["talk", "providers", "0", "apiKey"];
    const read = resolveConfigForRead(input, {});
    const config = coerceConfig(read.resolvedConfigRaw);
    setConfigResolutionFacts(config, read.resolutionFacts);
    const resolvedLiteral = "${MATERIALIZED_LITERAL}";
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "display-only",
          pathSegments,
          value: resolvedLiteral,
        },
      ],
    });
    const request = {
      commandName: "memory status",
      targetIds: new Set(["talk.providers.*.apiKey"]),
      allowedPaths: new Set([targetPath]),
    };

    const result = await resolveCommandSecretRefsViaGateway({ ...request, config });

    expect(readPath(result.resolvedConfig, pathSegments)).toBe(resolvedLiteral);
    expect(getAuthoredConfigSecretRef(config, targetPath)?.id).toBe("SOURCE_KEY");
    expect(getAuthoredConfigSecretRef(result.resolvedConfig, targetPath)).toBeNull();
    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath).toEqual({ [targetPath]: "resolved_gateway" });

    const next = await resolveCommandSecretRefsViaGateway({
      ...request,
      config: result.resolvedConfig,
    });
    expect(readPath(next.resolvedConfig, pathSegments)).toBe(resolvedLiteral);
    expect(next.hadUnresolvedTargets).toBe(false);
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("uses the explicit agent owner during channels resolve secret preflight", async () => {
    const channelPath = "channels.telegram.botToken";
    const channelPathSegments = ["channels", "telegram", "botToken"];
    const config = {
      agents: {
        entries: {
          ops: { sandbox: { backend: "docker" } },
          research: { sandbox: { backend: "docker" } },
        },
        defaults: {
          sandbox: {
            backend: "ssh",
            ssh: {
              identityData: {
                source: "env",
                provider: "default",
                id: "STALE_SANDBOX_IDENTITY",
              },
            },
          },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    } as unknown as OpenClawConfig;
    const { collectConfigAssignments } = await vi.importActual<
      typeof import("../secrets/runtime-config-collectors.js")
    >("../secrets/runtime-config-collectors.js");
    setSingleSecretTargetDeps({
      path: channelPath,
      pathSegments: channelPathSegments,
      collectConfigAssignments,
    });
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: channelPath,
          pathSegments: channelPathSegments,
          value: "resolved-telegram-token",
        },
      ],
      diagnostics: [],
    });

    const result = await resolveCommandSecretRefsViaGateway({
      config,
      commandName: "channels resolve",
      targetIds: new Set([channelPath]),
      agentId: "ops",
      mode: "read_only_operational",
    });

    expect(result.resolvedConfig.channels?.telegram?.botToken).toBe("resolved-telegram-token");
    expect(callGateway.mock.calls[0]?.[0].params).not.toHaveProperty("agentId");
  });

  it("retries old gateways without allowed paths and still filters scoped results", async () => {
    setDiscordAccountTargetDeps();
    callGateway
      .mockRejectedValueOnce(
        new Error("secrets.resolve invalid request: invalid secrets.resolve params"),
      )
      .mockResolvedValueOnce({
        assignments: [
          {
            path: "channels.discord.accounts.ops.token",
            pathSegments: ["channels", "discord", "accounts", "ops", "token"],
            value: "ops-token",
          },
          {
            path: "channels.discord.accounts.chat.token",
            pathSegments: ["channels", "discord", "accounts", "chat", "token"],
            value: "chat-token",
          },
        ],
        diagnostics: [
          "channels.discord.accounts.ops.token: gateway note",
          "channels.discord.accounts.chat.token: gateway note",
        ],
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

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway.mock.calls[0]?.[0].params).toEqual({
      commandName: "message",
      targetIds: ["channels.discord.accounts.*.token"],
      allowedPaths: ["channels.discord.accounts.ops.token"],
    });
    expect(callGateway.mock.calls[1]?.[0].params).toEqual({
      commandName: "message",
      targetIds: ["channels.discord.accounts.*.token"],
    });
    expect(result.resolvedConfig.channels?.discord?.accounts?.ops?.token).toBe("ops-token");
    expect(result.resolvedConfig.channels?.discord?.accounts?.chat?.token).toEqual({
      source: "env",
      provider: "default",
      id: "DISCORD_CHAT_TOKEN",
    });
    expect(result.targetStatesByPath).toEqual({
      "channels.discord.accounts.ops.token": "resolved_gateway",
    });
    expect(result.diagnostics).toEqual(["channels.discord.accounts.ops.token: gateway note"]);
    expect(result.hadUnresolvedTargets).toBe(false);
  });

  it("does not retry old gateways without forced active path support", async () => {
    setFirecrawlWebSearchTargetDeps();
    const envKey = "WEB_SEARCH_FIRECRAWL_OLD_GATEWAY_ONLY";
    await withEnvValue(envKey, undefined, async () => {
      callGateway.mockRejectedValueOnce(
        new Error("secrets.resolve invalid request: invalid secrets.resolve params"),
      );

      await expect(
        resolveCommandSecretRefsViaGateway({
          config: webConfig("firecrawl", "webSearch", envKey, { search: { provider: "exa" } }),
          commandName: "infer web search",
          targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          allowedPaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
          forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        }),
      ).rejects.toThrow(/does not support command-scoped secret resolution/i);
      expect(callGateway).toHaveBeenCalledTimes(1);
    });
  });

  it("fails fast when gateway-backed resolution is unavailable", async () => {
    const envKey = "TALK_API_KEY_FAILFAST";
    await withEnvValue(envKey, undefined, async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const resolution = resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: envKey,
        }),
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      });
      await expect(resolution).rejects.toThrow(
        /failed to resolve secrets from the active gateway snapshot/i,
      );
      await expect(resolution).rejects.toThrow(/local resolution also failed/i);
      await expect(resolution).rejects.toThrow(/check the configured secret sources/i);
      await expect(resolution).rejects.not.toThrow(envKey);
    });
  });

  it("keeps local exec SecretRef fallback enabled by default", async () => {
    await withSecureTestNodeExecPath(async () => {
      const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));

      const result = await resolveCommandSecretRefsViaGateway({
        config,
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "read_only_status",
      });

      expect(await markerExists(markerPath)).toBe(true);
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("exec-local-key");
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("skips local exec SecretRef fallback when the caller disallows exec providers", async () => {
    await withSecureTestNodeExecPath(async () => {
      const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));

      const result = await resolveCommandSecretRefsViaGateway({
        config,
        commandName: "doctor preview",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "read_only_status",
        allowLocalExecSecretRefs: false,
      });

      expect(await markerExists(markerPath)).toBe(false);
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
      expect(result.diagnostics).toContain(
        `doctor preview: ${TALK_TEST_PROVIDER_API_KEY_PATH} is unavailable in this command path; continuing with degraded read-only config.`,
      );
      expectDiagnostic(
        result,
        "doctor preview: skipped local exec SecretRef resolution for talk.providers.acme-speech.apiKey",
      );
      expectDiagnostic(result, "attempted local command-secret resolution");
    });
  });

  it("skips gateway resolution when gateway credentials would execute exec SecretRefs", async () => {
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        TALK_API_KEY: "local-fallback-key",
      },
      async () => {
        const result = await resolveCommandSecretRefsViaGateway({
          config: {
            ...buildTalkTestProviderConfig({
              source: "env",
              provider: "env",
              id: "TALK_API_KEY",
            }),
            gateway: {
              auth: {
                mode: "token",
                token: { source: "exec", provider: "vault", id: "gateway/token" },
              },
            },
            secrets: {
              providers: {
                env: { source: "env" },
                vault: {
                  source: "exec",
                  command: process.execPath,
                  args: ["-e", 'process.stdout.write(\'{"values":{"gateway/token":"x"}}\')'],
                  allowInsecurePath: true,
                  allowSymlinkCommand: true,
                  jsonOnly: true,
                },
              },
            },
          } as OpenClawConfig,
          commandName: "doctor preview",
          targetIds: new Set(["talk.providers.*.apiKey"]),
          mode: "read_only_status",
          allowLocalExecSecretRefs: false,
        });

        expect(callGateway).not.toHaveBeenCalled();
        expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("local-fallback-key");
        expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
        expectDiagnostic(
          result,
          "doctor preview: skipped gateway secrets.resolve because gateway credentials use exec SecretRefs at gateway.auth.token",
        );
      },
    );
  });

  it("falls back to local resolution for web search SecretRefs when gateway is unavailable", async () => {
    setGoogleWebSearchTargetDeps();
    const envKey = "WEB_SEARCH_GEMINI_API_KEY_LOCAL_FALLBACK";
    await withEnvValue(envKey, "gemini-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: webConfig("google", "webSearch", envKey, { search: { provider: "gemini" } }),
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

  it("drops gateway inactive diagnostics for forced active fallback paths", async () => {
    setFirecrawlWebSearchTargetDeps();
    const envKey = "WEB_FETCH_FIRECRAWL_FORCED_FALLBACK_KEY";
    await withEnvValue(envKey, "firecrawl-search-fallback-key", async () => {
      callGateway.mockResolvedValueOnce({
        assignments: [],
        diagnostics: [
          "plugins.entries.firecrawl.config.webSearch.apiKey: secret ref is configured on an inactive surface; tools.web.search is disabled.",
        ],
        inactiveRefPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
      });
      const result = await resolveCommandSecretRefsViaGateway({
        config: webConfig(
          "firecrawl",
          "webSearch",
          envKey,
          { search: { enabled: false, provider: "brave" }, fetch: { provider: "firecrawl" } },
          true,
        ),
        commandName: "infer web fetch",
        targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        allowedPaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
      });

      const firecrawlConfig = result.resolvedConfig.plugins?.entries?.firecrawl?.config as
        | { webSearch?: { apiKey?: unknown } }
        | undefined;
      expect(firecrawlConfig?.webSearch?.apiKey).toBe("firecrawl-search-fallback-key");
      expect(result.targetStatesByPath["plugins.entries.firecrawl.config.webSearch.apiKey"]).toBe(
        "resolved_local",
      );
      expect(callGateway.mock.calls[0]?.[0].params).toEqual({
        commandName: "infer web fetch",
        targetIds: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
        allowedPaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
        forcedActivePaths: ["plugins.entries.firecrawl.config.webSearch.apiKey"],
      });
      expect(result.diagnostics).not.toContain(
        "plugins.entries.firecrawl.config.webSearch.apiKey: secret ref is configured on an inactive surface; tools.web.search is disabled.",
      );
    });
  });

  it("honors forced active paths for non-web local fallback targets", async () => {
    const envKey = "GOOGLE_MODEL_FALLBACK_API_KEY";
    await withEnvValue(envKey, "google-local-fallback-key", async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          models: {
            providers: {
              google: {
                enabled: false,
                apiKey: { source: "env", provider: "default", id: envKey },
              },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "infer web search",
        targetIds: new Set(["models.providers.*.apiKey"]),
        allowedPaths: new Set(["models.providers.google.apiKey"]),
        forcedActivePaths: new Set(["models.providers.google.apiKey"]),
      });

      expect(result.resolvedConfig.models?.providers?.google?.apiKey).toBe(
        "google-local-fallback-key",
      );
      expect(result.targetStatesByPath["models.providers.google.apiKey"]).toBe("resolved_local");
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    });
  });

  it("marks web search refs inactive for another selected provider", async () => {
    const targetPath = "plugins.entries.google.config.webSearch.apiKey";
    setSingleSecretTargetDeps({
      path: targetPath,
      pathSegments: targetPath.split("."),
      resolveManifestContractOwnerPluginId: () => "other-plugin",
    });
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    const result = await resolveCommandSecretRefsViaGateway({
      config: webConfig("google", "webSearch", "WEB_INACTIVE_KEY", {
        search: { enabled: true, provider: "other-provider" },
      }),
      commandName: "agent",
      targetIds: new Set([targetPath]),
    });

    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath[targetPath]).toBe("inactive_surface");
    expect(result.diagnostics).toContain(
      `${targetPath}: tools.web.search.provider is "other-provider".`,
    );
  });

  it("returns a version-skew hint when gateway does not support secrets.resolve", async () => {
    const envKey = "TALK_API_KEY_UNSUPPORTED";
    callGateway.mockRejectedValueOnce(new Error("unknown method: secrets.resolve"));
    await withEnvValue(envKey, undefined, async () => {
      await expect(resolveTalkProviderApiKey({ envKey })).rejects.toThrow(
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
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: "TALK_API_KEY",
        }),
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).rejects.toThrow(/invalid secrets\.resolve payload/i);
  });

  it("fails when gateway assignment path does not exist in local config", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [
        {
          path: "talk.providers.missing.apiKey",
          pathSegments: ["talk", "providers", "missing", "apiKey"],
          value: "sk-live",
        },
      ],
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: buildTalkTestProviderConfig({
          source: "env",
          provider: "default",
          id: "TALK_API_KEY",
        }),
        commandName: "memory status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
      }),
    ).rejects.toThrow(
      "memory status: failed to apply resolved secret assignment at talk.providers.missing.apiKey",
    );
  });

  it("allows unresolved refs when gateway diagnostics mark the target as inactive", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [
        `${TALK_TEST_PROVIDER_API_KEY_PATH}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
      ],
    });

    const result = await resolveTalkProviderApiKey({ envKey: "TALK_API_KEY" });

    expectTalkProviderApiKeySecretRef(result, "TALK_API_KEY");
    expect(result.diagnostics).toEqual([
      `${TALK_TEST_PROVIDER_API_KEY_PATH}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
    ]);
  });

  it("uses inactiveRefPaths from structured response without parsing diagnostic text", async () => {
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: ["talk api key inactive"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });

    const result = await resolveTalkProviderApiKey({ envKey: "TALK_API_KEY" });

    expectTalkProviderApiKeySecretRef(result, "TALK_API_KEY");
    expect(result.diagnostics).toEqual(["talk api key inactive"]);
  });

  it("degrades unresolved refs in read-only status mode instead of throwing", async () => {
    const envKey = "TALK_API_KEY_SUMMARY_MISSING";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await withEnvValue(envKey, undefined, async () => {
      const result = await resolveTalkProviderApiKey({
        envKey,
        commandName: "status",
        mode: "read_only_status",
      });
      expect(readTalkProviderApiKey(result.resolvedConfig)).toBeUndefined();
      expect(result.hadUnresolvedTargets).toBe(true);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("unresolved");
      expectDiagnostic(
        result,
        `${TALK_TEST_PROVIDER_API_KEY_PATH} is unavailable in this command path`,
      );
    });
  });

  it("accepts an inactive web ref after an incomplete gateway snapshot", async () => {
    setGoogleWebSearchTargetDeps();
    const webPath = "plugins.entries.google.config.webSearch.apiKey";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    const result = await resolveCommandSecretRefsViaGateway({
      config: webConfig("google", "webSearch", "missing-disabled-web-ref", {
        search: { enabled: false, provider: "gemini" },
      }),
      commandName: "agent",
      targetIds: new Set([webPath]),
    });

    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath[webPath]).toBe("inactive_surface");
    expectDiagnostic(result, `${webPath}: tools.web.search is disabled.`);
  });

  it("keeps generic agent turns running when an active web tool credential is unavailable", async () => {
    setFirecrawlWebFetchTargetDeps();
    const webPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
      inactiveRefPaths: [webPath],
    });
    const result = await resolveCommandSecretRefsViaGateway({
      config: webConfig("firecrawl", "webFetch", "missing-optional-firecrawl-ref", {
        fetch: { provider: "firecrawl" },
      }),
      commandName: "reply",
      targetIds: new Set([webPath]),
      optionalActivePaths: new Set([webPath]),
    });

    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath[webPath]).toBe("inactive_surface");
  });

  it("fails closed when a configured web fetch provider owner cannot be proven", async () => {
    setFirecrawlWebFetchTargetDeps();
    const targetPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
    callGateway.mockResolvedValueOnce({
      assignments: [],
      diagnostics: [],
    });
    await expect(
      resolveCommandSecretRefsViaGateway({
        config: webConfig("firecrawl", "webFetch", "missing-active-web-fetch-ref", {
          fetch: { provider: "unregistered-provider" },
        }),
        commandName: "agent",
        targetIds: new Set([targetPath]),
      }),
    ).rejects.toThrow(`${targetPath} is unresolved in the active runtime snapshot`);
  });

  it("limits local fallback to targeted refs in read-only modes", async () => {
    const talkEnvKey = "TALK_API_KEY_TARGET_ONLY";
    const gatewayEnvKey = "GATEWAY_PASSWORD_UNRELATED";
    await withEnvAsync({ [talkEnvKey]: "target-only", [gatewayEnvKey]: undefined }, async () => {
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          ...buildTalkTestProviderConfig({
            source: "env",
            provider: "default",
            id: talkEnvKey,
          }),
          gateway: {
            auth: {
              password: { source: "env", provider: "default", id: gatewayEnvKey },
            },
          },
        } as unknown as OpenClawConfig,
        commandName: "status",
        targetIds: new Set(["talk.providers.*.apiKey"]),
        mode: "read_only_status",
      });

      expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("target-only");
      expect(result.hadUnresolvedTargets).toBe(false);
      expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
    });
  });
});
