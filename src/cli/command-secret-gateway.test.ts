import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const googleSearchPath = "plugins.entries.google.config.webSearch.apiKey";
const firecrawlSearchPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
const firecrawlFetchPath = "plugins.entries.firecrawl.config.webFetch.apiKey";
function expectDiagnostic(result: { diagnostics: string[] }, text: string) {
  expect(result.diagnostics).toEqual(expect.arrayContaining([expect.stringContaining(text)]));
}

function resolveWeb(
  plugin: string,
  credential: "webSearch" | "webFetch",
  envKey: string,
  web: NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>,
  options: Partial<ResolveOptions> = {},
  enabled?: boolean,
) {
  return resolveCommandSecretRefsViaGateway({
    config: {
      tools: { web },
      plugins: {
        entries: { [plugin]: { enabled, config: { [credential]: { apiKey: secretRef(envKey) } } } },
      },
    },
    commandName: "agent",
    targetIds: new Set([`plugins.entries.${plugin}.config.${credential}.apiKey`]),
    ...options,
  });
}

function expectWebKey(result: { resolvedConfig: OpenClawConfig }, keyPath: string, value: string) {
  expect(readPath(result.resolvedConfig, keyPath.split("."))).toBe(value);
}

function assignment(keyPath: string, value: string) {
  return { path: keyPath, pathSegments: keyPath.split("."), value };
}

type ResolveOptions = Parameters<typeof resolveCommandSecretRefsViaGateway>[0];
function resolveTalkProviderApiKey({
  envKey = "TALK_API_KEY",
  ...options
}: Partial<ResolveOptions> & { envKey?: string } = {}) {
  return resolveCommandSecretRefsViaGateway({
    config: buildTalkTestProviderConfig(secretRef(envKey)),
    commandName: "memory status",
    targetIds: new Set(["talk.providers.*.apiKey"]),
    ...options,
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
      ...buildTalkTestProviderConfig({ ...secretRef(refId), source: "exec" }),
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
  collectConfigAssignments?: typeof collectRuntimeConfigAssignments;
}): void {
  const pathSegments = params.path.split(".");
  const target = { path: params.path, pathSegments };
  vi.mocked(analyzeCommandSecretAssignmentsFromSnapshot).mockImplementation(
    ({ inactiveRefPaths, resolvedConfig }) => {
      const value = readPath(resolvedConfig, pathSegments);
      const resolved = typeof value === "string" && value.length > 0;
      const inactive = Boolean(inactiveRefPaths?.has(params.path));
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
          ...target,
          value: readPath(config, pathSegments),
        },
      ] as never,
  );
}

function setDiscordAccountTargetDeps(): void {
  const targets = ["ops", "chat"].map((account) => ({
    path: `channels.discord.accounts.${account}.token`,
    pathSegments: ["channels", "discord", "accounts", account, "token"],
    value: secretRef(`DISCORD_${account.toUpperCase()}_TOKEN`),
    entry: { expectedResolvedValue: "string" },
  }));
  vi.mocked(analyzeCommandSecretAssignmentsFromSnapshot).mockImplementation(
    () =>
      ({
        assignments: [assignment("channels.discord.accounts.ops.token", "ops-token")],
        diagnostics: [],
        inactive: [],
        unresolved: [],
      }) as never,
  );
  vi.mocked(collectRuntimeConfigAssignments).mockImplementation(async ({ context }) => {
    context.assignments.push(...targets.map((target) => ({ path: target.path }) as never));
  });
  vi.mocked(discoverConfigSecretTargetsByIds).mockImplementation(() => targets as never);
}

function setWebTargetDeps(targetPath: string, provider?: string, owner?: string): void {
  setSingleSecretTargetDeps({ path: targetPath });
  if (provider) {
    vi.mocked(resolveManifestContractOwnerPluginId).mockImplementation(({ contract, value }) =>
      contract ===
        (targetPath === firecrawlFetchPath ? "webFetchProviders" : "webSearchProviders") &&
      value === provider
        ? owner
        : undefined,
    );
  }
}

it("skips gateway resolution when all configured target refs are inactive", async () => {
  const search = { enabled: false, remote: { apiKey: secretRef("AGENT_MEMORY_API_KEY") } };
  const config = {
    agents: { entries: { main: { memory: { search } } } },
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
    assignments: [{ path: "display-only", pathSegments, value: resolvedLiteral }],
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
  const config = {
    agents: {
      entries: {
        ops: { sandbox: { backend: "docker" } },
        research: { sandbox: { backend: "docker" } },
      },
      defaults: {
        sandbox: {
          backend: "ssh",
          ssh: { identityData: secretRef("STALE_SANDBOX_IDENTITY") },
        },
      },
    },
    channels: {
      telegram: { botToken: secretRef("TELEGRAM_BOT_TOKEN") },
    },
  } as unknown as OpenClawConfig;
  const { collectConfigAssignments } = await vi.importActual<
    typeof import("../secrets/runtime-config-collectors.js")
  >("../secrets/runtime-config-collectors.js");
  setSingleSecretTargetDeps({
    path: channelPath,
    collectConfigAssignments,
  });
  callGateway.mockResolvedValueOnce({
    assignments: [assignment(channelPath, "resolved-telegram-token")],
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
        assignment("channels.discord.accounts.ops.token", "ops-token"),
        assignment("channels.discord.accounts.chat.token", "chat-token"),
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
            ops: { token: secretRef("DISCORD_OPS_TOKEN") },
            chat: { token: secretRef("DISCORD_CHAT_TOKEN") },
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
  expect(result.resolvedConfig.channels?.discord?.accounts?.chat?.token).toEqual(
    secretRef("DISCORD_CHAT_TOKEN"),
  );
  expect(result.targetStatesByPath).toEqual({
    "channels.discord.accounts.ops.token": "resolved_gateway",
  });
  expect(result.diagnostics).toEqual(["channels.discord.accounts.ops.token: gateway note"]);
  expect(result.hadUnresolvedTargets).toBe(false);
});

it("does not retry old gateways without forced active path support", async () => {
  setWebTargetDeps(firecrawlSearchPath);
  const envKey = "WEB_SEARCH_FIRECRAWL_OLD_GATEWAY_ONLY";
  vi.stubEnv(envKey, undefined);
  callGateway.mockRejectedValueOnce(
    new Error("secrets.resolve invalid request: invalid secrets.resolve params"),
  );

  await expect(
    resolveWeb(
      "firecrawl",
      "webSearch",
      envKey,
      { search: { provider: "exa" } },
      {
        commandName: "infer web search",
        allowedPaths: new Set([firecrawlSearchPath]),
        forcedActivePaths: new Set([firecrawlSearchPath]),
      },
    ),
  ).rejects.toThrow(/does not support command-scoped secret resolution/i);
  expect(callGateway).toHaveBeenCalledTimes(1);
});

it("fails fast when gateway-backed resolution is unavailable", async () => {
  const envKey = "TALK_API_KEY_FAILFAST";
  vi.stubEnv(envKey, undefined);
  callGateway.mockRejectedValueOnce(new Error("gateway closed"));
  const resolution = resolveTalkProviderApiKey({ envKey });
  await expect(resolution).rejects.toThrow(
    /failed to resolve secrets from the active gateway snapshot/i,
  );
  await expect(resolution).rejects.toThrow(/local resolution also failed/i);
  await expect(resolution).rejects.toThrow(/check the configured secret sources/i);
  await expect(resolution).rejects.not.toThrow(envKey);
});

it.each([true, false])("allows local exec SecretRef fallback: %s", async (allowExec) => {
  await withSecureTestNodeExecPath(async () => {
    const { config, markerPath } = await createExecProviderConfig("talk/providers/api-key");
    callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    const result = await resolveTalkProviderApiKey({
      config,
      commandName: allowExec ? "memory status" : "doctor preview",
      mode: "read_only_status",
      ...(allowExec ? {} : { allowLocalExecSecretRefs: false }),
    });
    expect(await markerExists(markerPath)).toBe(allowExec);
    expect(readTalkProviderApiKey(result.resolvedConfig)).toBe(
      allowExec ? "exec-local-key" : undefined,
    );
    expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe(
      allowExec ? "resolved_local" : "unresolved",
    );
    if (allowExec) {
      expectGatewayUnavailableLocalFallbackDiagnostics(result);
    } else {
      expect(result.diagnostics).toContain(
        `doctor preview: ${TALK_TEST_PROVIDER_API_KEY_PATH} is unavailable in this command path; continuing with degraded read-only config.`,
      );
      expectDiagnostic(
        result,
        "doctor preview: skipped local exec SecretRef resolution for talk.providers.acme-speech.apiKey",
      );
      expectDiagnostic(result, "attempted local command-secret resolution");
    }
  });
});

it("skips gateway resolution when gateway credentials would execute exec SecretRefs", async () => {
  vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
  vi.stubEnv("TALK_API_KEY", "local-fallback-key");
  const { config: execConfig } = await createExecProviderConfig("gateway/token");
  const result = await resolveTalkProviderApiKey({
    config: {
      ...buildTalkTestProviderConfig({ ...secretRef("TALK_API_KEY"), provider: "env" }),
      gateway: {
        auth: {
          mode: "token",
          token: { ...secretRef("gateway/token"), source: "exec" },
        },
      },
      secrets: {
        providers: {
          env: { source: "env" },
          default: execConfig.secrets!.providers!.default,
        },
      },
    } as OpenClawConfig,
    commandName: "doctor preview",
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
});

it("falls back to local resolution for web search SecretRefs when gateway is unavailable", async () => {
  setWebTargetDeps(googleSearchPath, "gemini", "google");
  const envKey = "WEB_SEARCH_GEMINI_API_KEY_LOCAL_FALLBACK";
  vi.stubEnv(envKey, "gemini-local-fallback-key");
  callGateway.mockRejectedValueOnce(new Error("gateway closed"));
  const result = await resolveWeb("google", "webSearch", envKey, {
    search: { provider: "gemini" },
  });
  expectWebKey(result, googleSearchPath, "gemini-local-fallback-key");
  expect(result.targetStatesByPath[googleSearchPath]).toBe("resolved_local");
  expectGatewayUnavailableLocalFallbackDiagnostics(result);
}, 300_000);

it("drops gateway inactive diagnostics for forced active fallback paths", async () => {
  setWebTargetDeps(firecrawlSearchPath);
  const envKey = "WEB_FETCH_FIRECRAWL_FORCED_FALLBACK_KEY";
  vi.stubEnv(envKey, "firecrawl-search-fallback-key");
  const diagnostic = `${firecrawlSearchPath}: secret ref is configured on an inactive surface; tools.web.search is disabled.`;
  callGateway.mockResolvedValueOnce({
    assignments: [],
    diagnostics: [diagnostic],
    inactiveRefPaths: [firecrawlSearchPath],
  });
  const result = await resolveWeb(
    "firecrawl",
    "webSearch",
    envKey,
    { search: { enabled: false, provider: "brave" }, fetch: { provider: "firecrawl" } },
    {
      commandName: "infer web fetch",
      allowedPaths: new Set([firecrawlSearchPath]),
      forcedActivePaths: new Set([firecrawlSearchPath]),
    },
    true,
  );
  expectWebKey(result, firecrawlSearchPath, "firecrawl-search-fallback-key");
  expect(result.targetStatesByPath[firecrawlSearchPath]).toBe("resolved_local");
  expect(callGateway.mock.calls[0]?.[0].params.forcedActivePaths).toEqual([firecrawlSearchPath]);
  expect(result.diagnostics).not.toContain(diagnostic);
});

it("honors forced active paths for non-web local fallback targets", async () => {
  const envKey = "GOOGLE_MODEL_FALLBACK_API_KEY";
  vi.stubEnv(envKey, "google-local-fallback-key");
  callGateway.mockRejectedValueOnce(new Error("gateway closed"));
  const result = await resolveCommandSecretRefsViaGateway({
    config: {
      models: {
        providers: {
          google: {
            enabled: false,
            apiKey: secretRef(envKey),
          },
        },
      },
    } as unknown as OpenClawConfig,
    commandName: "infer web search",
    targetIds: new Set(["models.providers.*.apiKey"]),
    allowedPaths: new Set(["models.providers.google.apiKey"]),
    forcedActivePaths: new Set(["models.providers.google.apiKey"]),
  });

  expect(result.resolvedConfig.models?.providers?.google?.apiKey).toBe("google-local-fallback-key");
  expect(result.targetStatesByPath["models.providers.google.apiKey"]).toBe("resolved_local");
  expectGatewayUnavailableLocalFallbackDiagnostics(result);
});

it.each([
  [
    "unsupported method",
    new Error("unknown method: secrets.resolve"),
    /does not support secrets\.resolve/i,
  ],
  [
    "invalid payload",
    { assignments: "not-an-array", diagnostics: [] },
    /invalid secrets\.resolve payload/i,
  ],
  [
    "missing assignment path",
    {
      assignments: [assignment("talk.providers.missing.apiKey", "sk-live")],
      diagnostics: [],
    },
    "memory status: failed to apply resolved secret assignment at talk.providers.missing.apiKey",
  ],
] as const)("rejects %s", async (_name, response, message) => {
  vi.stubEnv("TALK_API_KEY", undefined);
  if (response instanceof Error) {
    callGateway.mockRejectedValueOnce(response);
  } else {
    callGateway.mockResolvedValueOnce(response);
  }
  await expect(resolveTalkProviderApiKey()).rejects.toThrow(message);
});

it.each([
  {
    name: "diagnostic text",
    diagnostics: [
      `${TALK_TEST_PROVIDER_API_KEY_PATH}: secret ref is configured on an inactive surface; skipping command-time assignment.`,
    ],
  },
  {
    name: "structured paths without parseable diagnostic text",
    diagnostics: ["talk api key inactive"],
    inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
  },
])("accepts inactive refs from $name", async ({ name: _name, ...payload }) => {
  callGateway.mockResolvedValueOnce({ assignments: [], ...payload });
  const result = await resolveTalkProviderApiKey();
  expect(readTalkProviderApiKey(result.resolvedConfig)).toEqual(secretRef("TALK_API_KEY"));
  expect(result.diagnostics).toEqual(payload.diagnostics);
});

it("degrades unresolved refs in read-only status mode instead of throwing", async () => {
  const envKey = "TALK_API_KEY_SUMMARY_MISSING";
  callGateway.mockResolvedValueOnce({
    assignments: [],
    diagnostics: [],
  });
  vi.stubEnv(envKey, undefined);
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

it.each(["other provider", "disabled", "optional", "unknown owner"] as const)(
  "classifies an unresolved web credential: %s",
  async (scenario) => {
    const search = scenario === "other provider" || scenario === "disabled";
    const targetPath = search ? googleSearchPath : firecrawlFetchPath;
    if (search) {
      setWebTargetDeps(googleSearchPath, "gemini", "google");
    } else {
      setWebTargetDeps(firecrawlFetchPath, "firecrawl", "firecrawl");
    }
    if (scenario === "other provider") {
      vi.mocked(resolveManifestContractOwnerPluginId).mockReturnValue("other-plugin");
      callGateway.mockRejectedValueOnce(new Error("gateway closed"));
    } else {
      callGateway.mockResolvedValueOnce({
        assignments: [],
        diagnostics: [],
        ...(scenario === "optional" ? { inactiveRefPaths: [targetPath] } : {}),
      });
    }
    const resolution = resolveWeb(
      search ? "google" : "firecrawl",
      search ? "webSearch" : "webFetch",
      `missing-${scenario.replaceAll(" ", "-")}-web-ref`,
      search
        ? {
            search: {
              enabled: scenario !== "disabled",
              provider: scenario === "other provider" ? "other-provider" : "gemini",
            },
          }
        : {
            fetch: { provider: scenario === "optional" ? "firecrawl" : "unregistered-provider" },
          },
      scenario === "optional"
        ? { commandName: "reply", optionalActivePaths: new Set([targetPath]) }
        : {},
    );
    if (scenario === "unknown owner") {
      await expect(resolution).rejects.toThrow(
        `${targetPath} is unresolved in the active runtime snapshot`,
      );
      return;
    }
    const result = await resolution;
    expect(result.hadUnresolvedTargets).toBe(false);
    expect(result.targetStatesByPath[targetPath]).toBe("inactive_surface");
    if (scenario === "other provider") {
      expect(result.diagnostics).toContain(
        `${targetPath}: tools.web.search.provider is "other-provider".`,
      );
    } else if (scenario === "disabled") {
      expectDiagnostic(result, `${targetPath}: tools.web.search is disabled.`);
    }
  },
);

it("limits local fallback to targeted refs in read-only modes", async () => {
  const talkEnvKey = "TALK_API_KEY_TARGET_ONLY";
  const gatewayEnvKey = "GATEWAY_PASSWORD_UNRELATED";
  vi.stubEnv(talkEnvKey, "target-only");
  vi.stubEnv(gatewayEnvKey, undefined);
  callGateway.mockRejectedValueOnce(new Error("gateway closed"));
  const result = await resolveTalkProviderApiKey({
    config: {
      ...buildTalkTestProviderConfig(secretRef(talkEnvKey)),
      gateway: {
        auth: { password: secretRef(gatewayEnvKey) },
      },
    } as unknown as OpenClawConfig,
    commandName: "status",
    mode: "read_only_status",
  });

  expect(readTalkProviderApiKey(result.resolvedConfig)).toBe("target-only");
  expect(result.hadUnresolvedTargets).toBe(false);
  expect(result.targetStatesByPath[TALK_TEST_PROVIDER_API_KEY_PATH]).toBe("resolved_local");
});
