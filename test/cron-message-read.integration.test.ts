import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { json as readJson } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshPreparedModelRuntimeSnapshots } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import { AUTOMATIONS_TOOL_NAME } from "../src/agents/tools/automations-tool-name.js";
import { getReplyFromConfig } from "../src/auto-reply/reply/get-reply.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../src/config/config.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  getSuspensionVisibleCronTaskRunCount,
  waitForActiveCronTaskRuns,
} from "../src/cron/service/active-run-cancellation.js";
import { loadCronStore, resolveCronJobsStorePathFromConfig } from "../src/cron/store.js";
import type { CronJobCreate } from "../src/cron/types.js";
import * as mcpHttpHandlers from "../src/gateway/mcp-http.handlers.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../src/gateway/mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "../src/gateway/mcp-http.loopback-runtime.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { formatErrorMessage } from "../src/infra/errors.js";
import { redactToolPayloadText } from "../src/logging/redact.js";
import { buildAgentPeerSessionKey } from "../src/routing/session-key.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../src/state/openclaw-state-db.js";
import { createAccountOwnedScheduledJob } from "./helpers/cron/account-owned-scheduled-job.js";
import { installScheduledMessageReadRuntime } from "./helpers/cron/message-read-runtime.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";
import { createScheduledMessageReadModel } from "./helpers/scheduled-message-read-model.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

// Attached devices are outside these scheduled message journeys.
vi.mock("../src/agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

const channelId = "100000000000000003";
const guildId = "100000000000000001";
const messageId = "100000000000000020";
const providerMessage = "A synthetic message read by the scheduled turn.";
const providerTopic = "Topic set by the scheduled operator job.";
const modelId = "claude-sonnet-4-6";
const modelRef = `anthropic/${modelId}`;
const providerToken = "synthetic-scheduled-discord-token";
const embeddedModelId = "scheduled-message-read-fixture";
const modelToken = "synthetic-scheduled-model-token";
const nativeRequesterId = "100000000000000009";
const originalCreatorId = "100000000000000008";
const channelManagementRole = "100000000000000006";
const acceptedTopic = "Topic authorized for the recorded requester";
const deniedTopic = "Topic requiring a fresh permission check";
type ScheduledMessageScenario = {
  title: string;
  runtime: "claude-cli" | "openclaw";
  creator?: "trusted" | "account" | "native";
  action: "read" | "channel-info" | "channel-edit";
  disableBeforeResponse?: 200 | 429;
};

const scenarios: ScheduledMessageScenario[] = [
  { title: "claude-cli/read", runtime: "claude-cli", action: "read" },
  { title: "openclaw/channel-info", runtime: "openclaw", action: "channel-info" },
  {
    title: "edits Discord through a trusted operator-created cron job and its generated MCP grant",
    runtime: "claude-cli",
    action: "channel-edit",
  },
  {
    title: "blocks a Discord 429 retry after cron.update disables the executing job",
    runtime: "claude-cli",
    action: "channel-edit",
    disableBeforeResponse: 429,
  },
  {
    title: "preserves an accepted Discord edit after cron.update disables the executing job",
    runtime: "claude-cli",
    action: "channel-edit",
    disableBeforeResponse: 200,
  },
  { title: "openclaw/channel-edit", runtime: "openclaw", action: "channel-edit" },
  {
    title: "account/claude-cli/channel-info",
    runtime: "claude-cli",
    creator: "account",
    action: "channel-info",
  },
  {
    title: "account/openclaw/read",
    runtime: "openclaw",
    creator: "account",
    action: "read",
  },
  {
    title: "creates an account job from requester B and checks B's current Discord permissions",
    runtime: "claude-cli",
    creator: "native",
    action: "channel-edit",
  },
];

// Uses the maintained control/JSONL child protocol from anthropic/cli-process.test.ts.
// Only the model's decisions and Discord responses are synthetic. This child reads
// the real CLI-generated MCP config and credentials; it creates no authority.
const PROTOCOL_CHILD = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
const configPath = argument("--mcp-config");
if (!process.argv.includes("--mcp-config") || !configPath) {
  throw new Error("The real CLI runner did not generate an MCP config.");
}
const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.openclaw;
const url = new URL(server.url);
if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.pathname !== "/mcp") {
  throw new Error("Expected the task-owned loopback MCP endpoint.");
}
const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [
  name,
  value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (!process.env[key]) throw new Error("Missing generated MCP credential: " + key);
    return process.env[key];
  }),
]));
let sequence = 0;
const rpc = async (method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("MCP HTTP status " + response.status);
  return await response.json();
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } });
  } else if (message.type === "user") {
    void (async () => {
      const sessionId = message.session_id || argument("--session-id");
      send({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
      const createJob = process.env.OPENCLAW_SCHEDULED_CREATE_JOB;
      if (!createJob) {
        const gap = await fetch(process.env.OPENCLAW_SCHEDULED_READ_CLOCK_URL, { method: "POST" });
        if (!gap.ok) throw new Error("Could not advance the scheduled-read fixture clock.");
      }
      const listed = await rpc("tools/list");
      const reply = await rpc("tools/call", {
        name: createJob ? "${AUTOMATIONS_TOOL_NAME}" : "message",
        arguments: createJob
          ? { action: "add", job: JSON.parse(createJob) }
          : JSON.parse(process.env.OPENCLAW_SCHEDULED_READ_ARGUMENTS),
      });
      const followupArguments = createJob
        ? undefined
        : process.env.OPENCLAW_SCHEDULED_MESSAGE_FOLLOWUP_ARGUMENTS;
      const followupReply = followupArguments
        ? await rpc("tools/call", { name: "message", arguments: JSON.parse(followupArguments) })
        : undefined;
      const resultFile = createJob ? "./created-job.json" : "./mcp-result.json";
      writeFileSync(new URL(resultFile, import.meta.url), JSON.stringify({ listed, reply, followupReply }));
      send({ type: "result", subtype: "success", is_error: false,
        result: JSON.stringify(reply), session_id: sessionId,
        duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
        usage: {}, modelUsage: {}, permission_denials: [],
      });
      if (createJob) process.stdin.destroy();
    })().catch((error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
      process.stdin.destroy();
    });
  }
});
`;

type McpResponse = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: unknown }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
};

function describeFixtureError(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return redactToolPayloadText(
    cause === undefined
      ? formatErrorMessage(error)
      : `${formatErrorMessage(error)}; cause: ${formatErrorMessage(cause)}`,
  );
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("scheduled message actions", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(scenarios)("$title", { timeout: 60_000 }, async (scenario) => {
    const { runtime, action, disableBeforeResponse, creator = "trusted" } = scenario;
    const nativeCreator = creator === "native";
    // Local creator turns use the default account identity, independent of provider defaults.
    const creatorAccountId = nativeCreator ? "work" : "default";
    const creatorSessionKey = nativeCreator
      ? buildAgentPeerSessionKey({
          agentId: "main",
          channel: "discord",
          accountId: creatorAccountId,
          peerKind: "channel",
          peerId: channelId,
        })
      : "agent:main:scheduled-account-creator";
    const expectedTopic = nativeCreator ? acceptedTopic : providerTopic;
    const expectedProviderToken =
      creator === "account" ? "synthetic-creator-discord-token" : providerToken;
    const actionParams = {
      action,
      channel: "discord",
      ...(creator === "trusted" ? { accountId: creatorAccountId } : {}),
      ...(action === "read"
        ? { target: `channel:${channelId}`, limit: 1 }
        : action === "channel-edit"
          ? { target: `channel:${channelId}`, topic: expectedTopic }
          : { channelId }),
    };
    const expectedResult =
      action === "read"
        ? {
            ok: true,
            channelId,
            messages: [{ id: messageId, channel_id: channelId, content: providerMessage }],
          }
        : {
            ok: true,
            channel: {
              id: channelId,
              guild_id: guildId,
              type: 0,
              name: "scheduled-read",
              ...(action === "channel-edit" ? { topic: expectedTopic } : {}),
            },
          };
    const assertToolResult = (text: string) => {
      expect(JSON.parse(text)).toMatchObject(expectedResult);
    };
    const assertAccountToolSchema =
      creator === "account"
        ? (schema: unknown) => {
            const properties = isRecord(schema) ? schema.properties : undefined;
            const actionSchema = isRecord(properties) ? properties.action : undefined;
            const advertisedActions = isRecord(actionSchema) ? actionSchema.enum : undefined;
            expect(advertisedActions).toContain(action);
            expect(advertisedActions).not.toContain(action === "read" ? "channel-info" : "read");
          }
        : undefined;
    const embeddedModel = createScheduledMessageReadModel({
      modelId: embeddedModelId,
      apiKey: modelToken,
      actionParams,
      assertToolResult,
      assertToolSchema: assertAccountToolSchema,
    });
    const isolatedHome = expectDefined(process.env.OPENCLAW_TEST_HOME, "isolated test HOME");
    const root = tempDirs.make("scheduled-message-read-", isolatedHome);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const childPath = path.join(root, "claude.mjs");
    const cleanup: Array<() => void | Promise<void>> = [];
    const requests: Array<{ method: string; path: string; authorizationMatches: boolean }> = [];
    const edits: unknown[] = [];
    const heldPatch = disableBeforeResponse
      ? { entered: createDeferred(), release: createDeferred() }
      : undefined;
    // Job cancellation may terminate the child before it can persist the MCP reply.
    const mcpHandlerSpy = disableBeforeResponse
      ? vi.spyOn(mcpHttpHandlers, "handleMcpJsonRpc")
      : undefined;
    const providerErrors: string[] = [];
    const providerWork = new Set<Promise<void>>();
    let requesterPermissions = 16n; // Discord MANAGE_CHANNELS.
    let metadataControl: "pending" | "passed" = "pending";
    const diagnostics = (result: unknown) =>
      redactToolPayloadText(
        JSON.stringify({
          result,
          metadataControl,
          requests,
          providerErrors,
          model: embeddedModel.observation,
        }),
      );
    const readObservedMcpResponse = async (method: "tools/list" | "tools/call") => {
      const spy = expectDefined(mcpHandlerSpy, "MCP handler observer for a disabled job");
      const index = spy.mock.calls.findIndex(
        ([request]) =>
          request.message.method === method &&
          request.hookContext?.workspaceDir === workspaceDir &&
          (method === "tools/list" || request.message.params?.name === "message"),
      );
      const returned = expectDefined(spy.mock.results[index], `Scheduled MCP ${method} result`);
      if (returned.type !== "return") {
        throw new Error(`Scheduled MCP ${method} did not return a response promise.`);
      }
      return (await withTestTimeout(
        returned.value,
        45_000,
        `Expected scheduled MCP ${method} response after job disable`,
      )) as McpResponse;
    };
    await runQaGatewayFixture(
      async () => {
        await mkdir(workspaceDir, { recursive: true });
        await writeFile(childPath, `#!${process.execPath}\n${PROTOCOL_CHILD}`, { mode: 0o700 });
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
        vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-config"));
        for (const key of [
          "OPENCLAW_TEST_MINIMAL_GATEWAY",
          "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
          "OPENCLAW_SKIP_CANVAS_HOST",
          "OPENCLAW_SKIP_GMAIL_WATCHER",
        ]) {
          vi.stubEnv(key, "1");
        }
        // Minimal mode suppresses initial channel startup; the skip flags would also
        // remove channel credentials from the published runtime config.
        vi.stubEnv("OPENCLAW_SKIP_CHANNELS", undefined);
        vi.stubEnv("OPENCLAW_SKIP_PROVIDERS", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
        const gatewayPort = await getGatewayE2ePortBlock();
        const gatewayToken = "synthetic-scheduled-read-gateway-token";
        vi.stubEnv("OPENCLAW_SCHEDULED_READ_ARGUMENTS", JSON.stringify(actionParams));
        vi.stubEnv("OPENCLAW_SCHEDULED_CREATE_JOB", undefined);
        vi.stubEnv(
          "OPENCLAW_SCHEDULED_MESSAGE_FOLLOWUP_ARGUMENTS",
          nativeCreator
            ? JSON.stringify({
                action: "channel-edit",
                channel: "discord",
                target: `channel:${channelId}`,
                topic: deniedTopic,
              })
            : undefined,
        );
        for (const key of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
        ]) {
          vi.stubEnv(key, undefined);
        }
        cleanup.push(() => clearRuntimeConfigSnapshot());
        cleanup.push(() => closeOpenClawStateDatabaseForTest());
        cleanup.push(() => closeOpenClawStateDatabaseAsync());

        const provider = createServer((req, res) => {
          const work = (async () => {
            const url = new URL(req.url ?? "/", "http://fixture.invalid");
            if (req.method === "POST" && url.pathname === "/scheduled-clock-gap") {
              expect(runtime).toBe("claude-cli");
              expect(metadataControl).toBe("passed");
              const realNow = Date.now.bind(Date);
              // The real CLI has its grant; model a pause beyond its former timeout-plus-grace TTL.
              vi.spyOn(Date, "now").mockImplementation(() => realNow() + 120_000);
              res.writeHead(200).end();
              return;
            }
            if (req.method === "POST" && url.pathname === "/v1/responses") {
              expect(runtime, "embedded model request uses the selected runtime").toBe("openclaw");
              await embeddedModel.respond(req, res);
              return;
            }
            const authorizationMatches =
              req.headers.authorization === `Bot ${expectedProviderToken}`;
            requests.push({ method: req.method ?? "", path: url.pathname, authorizationMatches });
            expect(authorizationMatches, "Discord fixture authorization matches").toBe(true);
            if (req.method === "PATCH" && url.pathname === `/api/v10/channels/${channelId}`) {
              const edit: unknown = await readJson(req);
              edits.push(edit);
              expect(edit).toEqual({ topic: expectedTopic });
              if (heldPatch && edits.length === 1) {
                heldPatch.entered.resolve();
                await heldPatch.release.promise;
                if (disableBeforeResponse === 429) {
                  res
                    .writeHead(429, {
                      "content-type": "application/json",
                      "retry-after": "0.001",
                    })
                    .end(JSON.stringify({ message: "Rate limited", retry_after: 0.001 }));
                  return;
                }
              }
              if (nativeCreator) {
                // Each edit must use B's current permissions, independent of attribution A.
                requesterPermissions = 0n;
              }
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  id: channelId,
                  type: 0,
                  guild_id: guildId,
                  name: "scheduled-read",
                  topic: expectedTopic,
                }),
              );
              return;
            }
            expect(req.method).toBe("GET");
            let body: unknown =
              url.pathname === `/api/v10/channels/${channelId}`
                ? { id: channelId, type: 0, guild_id: guildId, name: "scheduled-read" }
                : url.pathname === `/api/v10/channels/${channelId}/messages`
                  ? [
                      {
                        id: messageId,
                        channel_id: channelId,
                        content: providerMessage,
                        author: {
                          id: "100000000000000009",
                          username: "synthetic",
                          discriminator: "0",
                        },
                        timestamp: "2026-09-16T09:00:00.000Z",
                        type: 0,
                        attachments: [],
                        embeds: [],
                      },
                    ]
                  : undefined;
            if (nativeCreator && url.pathname === `/api/v10/guilds/${guildId}`) {
              body = {
                id: guildId,
                owner_id: originalCreatorId,
                roles: [
                  { id: guildId, permissions: "0" },
                  { id: channelManagementRole, permissions: requesterPermissions.toString() },
                ],
              };
            } else if (
              nativeCreator &&
              url.pathname === `/api/v10/guilds/${guildId}/members/${nativeRequesterId}`
            ) {
              body = { user: { id: nativeRequesterId }, roles: [channelManagementRole] };
            }
            if (body === undefined) {
              throw new Error(`Unexpected provider request: ${req.method} ${url.pathname}`);
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
          })().catch((error: unknown) => {
            providerErrors.push(describeFixtureError(error));
            res.writeHead(500).end();
          });
          providerWork.add(work);
          void work.finally(() => providerWork.delete(work));
        });
        cleanup.push(async () => {
          await closeServer(provider);
          await Promise.all(providerWork);
        });
        await new Promise<void>((resolve, reject) => {
          provider.once("error", reject);
          provider.listen(0, "127.0.0.1", resolve);
        });
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected provider TCP address");
        }
        const providerOrigin = `http://127.0.0.1:${address.port}`;
        vi.stubEnv("OPENCLAW_SCHEDULED_READ_CLOCK_URL", `${providerOrigin}/scheduled-clock-gap`);
        const embedded = buildMockOpenAiResponsesProvider(`${providerOrigin}/v1`, embeddedModelId);
        const selectedModelRef = runtime === "openclaw" ? embedded.modelRef : modelRef;
        const cfg: OpenClawConfig = {
          gateway: {
            mode: "local",
            port: gatewayPort,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            ownership: "explicit",
            entries: { main: {} },
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              timeoutSeconds: 40,
              model: { primary: selectedModelRef, fallbacks: [] },
              models: {
                [modelRef]: { agentRuntime: { id: "claude-cli" } },
                [embedded.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              thinkingDefault: "off",
            },
          },
          models: {
            providers: {
              [embedded.providerId]: {
                ...embedded.config,
                apiKey: modelToken,
                request: { allowPrivateNetwork: true },
              },
              anthropic: {
                api: "anthropic-messages",
                baseUrl: "https://api.anthropic.com",
                apiKey: "synthetic-unused-model-key",
                models: [
                  {
                    id: modelId,
                    name: "Synthetic Claude CLI model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200_000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          tools: {
            // The scripted provider asserts the direct message schema and scheduled authority.
            toolSearch: false,
            allow: creator !== "trusted" ? ["message", "automations"] : ["message"],
          },
          ...(nativeCreator
            ? { commands: { ownerAllowFrom: [`discord:${nativeRequesterId}`] } }
            : {}),
          plugins: { allow: ["anthropic", "discord"], slots: { memory: "none" } },
          channels: {
            discord: {
              enabled: true,
              // Advancing the grant clock must not start an unrelated Discord transport.
              healthMonitor: { enabled: false },
              ...(nativeCreator
                ? {
                    token: "synthetic-unused-default-token",
                    defaultAccount: "default",
                    accounts: {
                      default: { actions: { channels: false } },
                      work: { token: expectedProviderToken, actions: { channels: true } },
                    },
                  }
                : creator === "account"
                  ? {
                      defaultAccount: "other",
                      accounts: {
                        default: {
                          token: expectedProviderToken,
                          actions: {
                            messages: action === "read",
                            channelInfo: action === "channel-info",
                          },
                        },
                        other: {
                          token: "synthetic-other-discord-token",
                          actions: {
                            messages: action === "channel-info",
                            channelInfo: action === "read",
                          },
                        },
                      },
                    }
                  : { token: providerToken }),
              groupPolicy: "allowlist",
              guilds: { [guildId]: { channels: { "*": { enabled: true } } } },
            },
          },
          cron: { enabled: false },
        };
        await writeFile(configPath, JSON.stringify(cfg));
        setRuntimeConfigSnapshot(cfg, cfg);
        if (nativeCreator) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: creatorSessionKey },
            {
              sessionId: "native-creator-session",
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "channel", id: originalCreatorId },
            },
          );
        }

        vi.stubEnv("DISCORD_API_URL", `${providerOrigin}/api/v10`);
        await ensureMcpLoopbackServer(0);
        cleanup.push(() => closeMcpLoopbackServer());
        const mcpRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "task-owned MCP runtime");
        const mcpOrigin = `http://127.0.0.1:${mcpRuntime.port}`;
        const realFetch = globalThis.fetch.bind(globalThis);
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (
              url.origin !== providerOrigin &&
              url.origin !== mcpOrigin &&
              url.origin !== `http://127.0.0.1:${gatewayPort}`
            ) {
              throw new Error(`Unexpected fixture network destination: ${url.origin}`);
            }
            return await realFetch(input, init);
          }),
        );

        const stopBindingManager = await installScheduledMessageReadRuntime({
          cfg,
          childPath,
          nativeCreatorAccountId: nativeCreator ? creatorAccountId : undefined,
          cleanup,
        });
        cleanup.push(() => resetPreparedModelRuntimeSnapshotsForTest());
        const finished = createDeferred<Record<string, unknown>>();
        const scheduledJob: { id?: string } = {};
        const gateway = await startGatewayWithClient({
          port: gatewayPort,
          cfg,
          configPath,
          token: gatewayToken,
          scopes: ["operator.admin"],
          onEvent: (event) => {
            if (
              event.event === "cron" &&
              isRecord(event.payload) &&
              event.payload.action === "finished" &&
              event.payload.jobId === scheduledJob.id
            ) {
              finished.resolve(event.payload);
            }
          },
        });
        cleanup.push(async () => {
          await runQaGatewayFixture(
            () => disconnectGatewayClient(gateway.client),
            () => stopBindingManager(),
            () => gateway.server.close({ reason: "scheduled read fixture complete" }),
          );
        });
        await gateway.server.startupSettled;
        await refreshPreparedModelRuntimeSnapshots(getRuntimeConfig(), {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        const runtimeConfig = getRuntimeConfig();
        const { fetchChannelInfoDiscord } = await import("../extensions/discord/runtime-api.js");
        const metadata = await fetchChannelInfoDiscord(channelId, {
          cfg: runtimeConfig,
          accountId: creatorAccountId,
        }).catch((error: unknown) => {
          throw new Error(diagnostics({ metadataError: describeFixtureError(error) }));
        });
        expect(metadata, diagnostics(metadata)).toMatchObject({
          id: channelId,
          type: 0,
          guild_id: guildId,
        });
        expect(requests, diagnostics(metadata)).toEqual([
          {
            method: "GET",
            path: `/api/v10/channels/${channelId}`,
            authorizationMatches: true,
          },
        ]);
        metadataControl = "passed";
        // The direct transport control cannot satisfy the scheduled journey's evidence.
        requests.length = 0;
        const params = {
          name: nativeCreator
            ? "Edit Discord for the recorded requester"
            : `Scheduled Discord ${action}`,
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "agentTurn",
            message: nativeCreator
              ? `Set Discord channel ${channelId} to topic ${acceptedTopic}, then try topic ${deniedTopic}, using account ${creatorAccountId}.`
              : `Use message action ${action} for Discord channel ${channelId}${creator === "trusted" ? " with account default" : " without an accountId argument"}.`,
            toolsAllow: ["message"],
          },
          delivery:
            creator === "account"
              ? { mode: "none", channel: "discord", accountId: "other" }
              : { mode: "none" },
        } satisfies CronJobCreate;
        let created: { id: string };
        if (nativeCreator) {
          vi.stubEnv("OPENCLAW_SCHEDULED_CREATE_JOB", JSON.stringify(params));
          let producerReply: Awaited<ReturnType<typeof getReplyFromConfig>>;
          try {
            producerReply = await getReplyFromConfig(
              {
                Body: "Schedule these Discord channel topic changes for later.",
                From: `discord:channel:${channelId}`,
                To: `channel:${channelId}`,
                Provider: "discord",
                Surface: "discord",
                AccountId: creatorAccountId,
                SessionKey: creatorSessionKey,
                ChatType: "channel",
                NativeChannelId: channelId,
                GroupSpace: guildId,
                SenderId: nativeRequesterId,
                MessageSid: "100000000000000021",
                WasMentioned: true,
              },
              { runId: "native-cron-creator" },
            );
          } finally {
            vi.stubEnv("OPENCLAW_SCHEDULED_CREATE_JOB", undefined);
          }
          for (const payload of Array.isArray(producerReply) ? producerReply : [producerReply]) {
            expect(payload?.isError, diagnostics(producerReply)).not.toBe(true);
          }
          const creation = JSON.parse(
            await readFile(path.join(root, "created-job.json"), "utf8").catch((error: unknown) => {
              throw new Error(
                diagnostics({ producerReply, creationError: describeFixtureError(error) }),
              );
            }),
          ) as { listed: McpResponse; reply: McpResponse };
          expect(creation.listed.result?.tools).toContainEqual(
            expect.objectContaining({ name: AUTOMATIONS_TOOL_NAME }),
          );
          expect(creation.reply.error, diagnostics(creation.reply)).toBeUndefined();
          expect(creation.reply.result?.isError, diagnostics(creation.reply)).toBe(false);
          const response: unknown = JSON.parse(
            creation.reply.result?.content?.find((item) => item.type === "text")?.text ?? "null",
          );
          if (!isRecord(response) || typeof response.id !== "string") {
            throw new Error(
              diagnostics({ creation, reason: "automation creation returned no job id" }),
            );
          }
          created = { id: response.id };
        } else if (creator === "trusted") {
          created = await gateway.client.request<{ id: string }>("cron.add", params);
        } else {
          created = await createAccountOwnedScheduledJob({
            cfg: runtimeConfig,
            gatewayPort,
            agentId: "main",
            accountId: creatorAccountId,
            sessionKey: creatorSessionKey,
            model: {
              provider: runtime === "openclaw" ? embedded.providerId : "anthropic",
              model: runtime === "openclaw" ? embedded.modelId : modelId,
            },
            job: params,
          });
        }
        scheduledJob.id = created.id;
        const storePath = resolveCronJobsStorePathFromConfig(getRuntimeConfig());
        const job = expectDefined(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === created.id),
          "persisted scheduled job",
        );
        if (nativeCreator) {
          expect(job).toMatchObject({
            owner: { sessionKey: creatorSessionKey, accountId: creatorAccountId },
            scheduledToolPolicy: {
              version: 1,
              mode: "account",
              ownerSessionKey: creatorSessionKey,
              ownerAccountId: creatorAccountId,
            },
            toolsAllowProvenance: {
              version: 1,
              channelRequester: {
                version: 1,
                channel: "discord",
                accountId: creatorAccountId,
                senderId: nativeRequesterId,
              },
            },
            createdActor: { id: originalCreatorId },
          });
          expect(job.payload.toolsAllow).toEqual(["message"]);
          expect(job.payload.toolsAllowIsDefault).toBeUndefined();
        } else if (creator === "trusted") {
          expect(job.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
        } else {
          expect(job.owner).toEqual({
            agentId: "main",
            sessionKey: creatorSessionKey,
            accountId: creatorAccountId,
          });
          expect(job.scheduledToolPolicy).toEqual({
            version: 1,
            mode: "account",
            ownerSessionKey: creatorSessionKey,
            ownerAccountId: creatorAccountId,
          });
          expect(job.toolsAllowProvenance).toEqual({
            version: 1,
            source: "final-executable-surface",
            callerOrigin: { kind: "local" },
          });
          expect(job.delivery).toMatchObject({
            mode: "none",
            channel: "discord",
            accountId: "other",
          });
        }
        expect(job).toMatchObject({ payload: { toolsAllow: ["message"] } });
        expect(
          await gateway.client.request("cron.run", { id: job.id, mode: "force" }),
        ).toMatchObject({ ok: true, enqueued: true });
        if (heldPatch) {
          try {
            await withTestTimeout(
              Promise.race([
                heldPatch.entered.promise,
                finished.promise.then((completion) => {
                  throw new Error(diagnostics({ completedBeforePatch: completion }));
                }),
              ]),
              45_000,
              "Expected authenticated scheduled PATCH before disabling the job",
            );
            expect(edits).toEqual([{ topic: providerTopic }]);
            await gateway.client.request("cron.update", {
              id: job.id,
              patch: { enabled: false },
            });
            const disabledJob = expectDefined(
              (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
              "persisted disabled scheduled job",
            );
            expect(disabledJob).toMatchObject({
              id: job.id,
              enabled: false,
              scheduledToolPolicy: { version: 1, mode: "trusted" },
              payload: { toolsAllow: ["message"] },
            });
            if (disableBeforeResponse === 200) {
              const requestSignal = expectDefined(
                mcpHandlerSpy?.mock.calls.find(
                  ([request]) =>
                    request.message.method === "tools/call" &&
                    request.hookContext?.workspaceDir === workspaceDir,
                )?.[0].signal,
                "original scheduled MCP request signal",
              );
              await withTestTimeout(
                requestSignal.aborted
                  ? Promise.resolve()
                  : new Promise<void>((resolve) => {
                      requestSignal.addEventListener("abort", () => resolve(), { once: true });
                    }),
                10_000,
                "Expected the disabled job to close its original MCP request",
              );
            }
          } finally {
            heldPatch.release.resolve();
          }
        }
        const completion = await withTestTimeout(
          finished.promise,
          45_000,
          "Expected scheduled agent completion",
        );
        if (!disableBeforeResponse) {
          expect(completion, diagnostics(completion)).toMatchObject({ status: "ok" });
        }
        let text: string | undefined;
        if (runtime === "claude-cli") {
          const observation: {
            listed: McpResponse;
            reply: McpResponse;
            followupReply?: McpResponse;
          } = mcpHandlerSpy
            ? {
                listed: await readObservedMcpResponse("tools/list"),
                reply: await readObservedMcpResponse("tools/call"),
              }
            : JSON.parse(await readFile(path.join(root, "mcp-result.json"), "utf8"));
          if (disableBeforeResponse) {
            expect(await waitForActiveCronTaskRuns(10_000)).toEqual({ drained: true, active: 0 });
            expect(getSuspensionVisibleCronTaskRunCount({ agentId: "main" })).toBe(0);
          }
          const messageTool = expectDefined(
            observation.listed.result?.tools?.find((tool) => tool.name === "message"),
            "scheduled CLI message tool",
          );
          assertAccountToolSchema?.(messageTool.inputSchema);
          expect(observation.reply.error, diagnostics(observation.reply)).toBeUndefined();
          expect(observation.reply.result?.isError, diagnostics(observation.reply)).toBe(
            disableBeforeResponse === 429,
          );
          text = observation.reply.result?.content?.find((item) => item.type === "text")?.text;
          if (nativeCreator) {
            expect(requests).toContainEqual({
              method: "GET",
              path: `/api/v10/channels/${channelId}`,
              authorizationMatches: true,
            });
            expect(requests).toContainEqual({
              method: "GET",
              path: `/api/v10/guilds/${guildId}/members/${nativeRequesterId}`,
              authorizationMatches: true,
            });
            const denied = expectDefined(
              observation.followupReply,
              "second channel-edit MCP result",
            );
            expect(denied.error, diagnostics(denied)).toBeUndefined();
            expect(denied.result?.isError, diagnostics(denied)).toBe(true);
            expect(denied.result?.content?.map((item) => item.text).join("\n")).toContain(
              "Sender does not have required permissions",
            );
          }
        } else {
          expect(embeddedModel.observation, diagnostics(completion)).toMatchObject({
            requests: 2,
            messageToolAdvertised: true,
          });
          text = embeddedModel.observation.toolOutput;
        }
        if (disableBeforeResponse === 429) {
          expect(text).toMatch(/authority is no longer active|disabled by operator|abort|cancel/i);
        } else {
          assertToolResult(expectDefined(text, "scheduled provider tool result"));
        }
        if (action === "channel-edit") {
          expect(requests.filter((request) => request.method === "PATCH")).toEqual([
            {
              method: "PATCH",
              path: `/api/v10/channels/${channelId}`,
              authorizationMatches: true,
            },
          ]);
          expect(edits).toEqual([{ topic: expectedTopic }]);
        } else {
          expect(requests).toContainEqual({
            method: "GET",
            path: `/api/v10/channels/${channelId}`,
            authorizationMatches: true,
          });
          if (action === "read") {
            expect(requests).toContainEqual({
              method: "GET",
              path: `/api/v10/channels/${channelId}/messages`,
              authorizationMatches: true,
            });
          }
          expect(edits).toEqual([]);
        }
        expect(providerErrors).toEqual([]);
      },
      // Release provider responses before Gateway shutdown waits for pending writes.
      () => heldPatch?.release.resolve(),
      () => runQaGatewayFixture(async () => {}, ...cleanup.toReversed()),
      () => vi.restoreAllMocks(),
      () => vi.unstubAllGlobals(),
      () => vi.unstubAllEnvs(),
    );
  });
});
