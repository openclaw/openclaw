import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { loadCliSessionHistoryMessages } from "../agents/cli-runner/session-history.js";
import { computeCacheHitRate } from "../agents/live-cache-test-support.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { sleep } from "../utils/sleep.js";
import type { GatewayClient } from "./client.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

export const CLI_BACKEND_PROBE_PLUGIN_ID = "cli-backend-probe";
export const MCP_SCHEMA_PROBE_TOOL_NAME = "mcp_schema_probe_no_args";
export const CLI_ANNOUNCE_BARRIER_TOOL_NAME = "cli_announce_barrier";
export const CLI_CACHE_AUTH_PROFILE_ID = "claude-cli:live-cache";

const execFileAsync = promisify(execFile);

export async function createCliAnnounceBarrier() {
  const requestPath = `/cli-announce-${randomBytes(12).toString("hex")}`;
  let response: ServerResponse | undefined;
  let calls = 0;
  const server = createServer((request, incomingResponse) => {
    if (request.url !== requestPath) {
      incomingResponse.writeHead(404).end();
      return;
    }
    calls += 1;
    if (calls !== 1) {
      incomingResponse.writeHead(409).end();
      return;
    }
    response = incomingResponse;
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("CLI announce barrier did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}${requestPath}`,
    get calls() {
      return calls;
    },
    release() {
      response?.end("CLI announce barrier released");
      response = undefined;
    },
    async close() {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}

export type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];

export async function initializeCacheProbeGitWorkspace(workspaceDir: string): Promise<void> {
  for (const args of [
    ["init", "--quiet", workspaceDir],
    ["-C", workspaceDir, "config", "user.name", "OpenClaw Tests"],
    ["-C", workspaceDir, "config", "user.email", "openclaw-tests@localhost"],
    ["-C", workspaceDir, "add", "--all"],
    ["-C", workspaceDir, "commit", "--quiet", "-m", "cache probe baseline"],
  ]) {
    await execFileAsync("git", args);
  }
}

type CliCacheUsage = Partial<Record<"input" | "cacheRead" | "cacheWrite", number>>;
type CliCacheMeta = Partial<Record<"usage" | "lastCallUsage", CliCacheUsage>>;

export function logCliCacheUsage(turn: string, result: unknown): number {
  // SAFETY: agent results expose optional normalized usage metadata.
  const typedResult = result as { meta?: { agentMeta?: CliCacheMeta } };
  const agentMeta = typedResult.meta?.agentMeta;
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage;
  if (!usage) {
    throw new Error("Claude CLI cache probe did not return normalized usage metadata");
  }
  const hitRate = computeCacheHitRate(usage);
  process.stderr.write(
    `[gateway-cli-cache] ${turn} input=${usage.input ?? 0} cacheRead=${usage.cacheRead ?? 0} cacheWrite=${usage.cacheWrite ?? 0} hitRate=${(hitRate * 100).toFixed(2)}%\n`,
  );
  return hitRate;
}

export async function createCliBackendProbePlugin(
  tempDir: string,
  probes: {
    mcpSchema: boolean;
    announceBarrierUrl: string;
    continuity?: { sessionKey: string; firstTurnMarker: string; injectedContext: string };
  },
): Promise<{ pluginPath: string; resultToken: string }> {
  const pluginDir = path.join(tempDir, CLI_BACKEND_PROBE_PLUGIN_ID);
  const resultToken = `MCP-SCHEMA-${randomBytes(6).toString("hex").toUpperCase()}`;
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: CLI_BACKEND_PROBE_PLUGIN_ID,
      name: "CLI Backend Probe",
      description: "Live test plugin for CLI completion ordering, continuity, and MCP schemas",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: {
        tools: [
          CLI_ANNOUNCE_BARRIER_TOOL_NAME,
          ...(probes.mcpSchema ? [MCP_SCHEMA_PROBE_TOOL_NAME] : []),
        ],
      },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
  id: "${CLI_BACKEND_PROBE_PLUGIN_ID}",
  name: "CLI Backend Probe",
  register(api) {
    api.registerTool({
      name: "${CLI_ANNOUNCE_BARRIER_TOOL_NAME}",
      description: "Wait for the live test controller to release the parent turn after child completion",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params, signal) {
        const response = await fetch(${JSON.stringify(probes.announceBarrierUrl)}, { signal });
        if (!response.ok) throw new Error("CLI announce barrier request failed");
        return { content: [{ type: "text", text: await response.text() }] };
      },
    });
    const continuity = ${JSON.stringify(probes.continuity ?? null)};
    if (continuity) {
      api.on("before_prompt_build", (event, ctx) => {
        if (ctx.sessionKey === continuity.sessionKey && event.prompt.includes(continuity.firstTurnMarker)) {
          return { prependContext: continuity.injectedContext };
        }
      });
    }
    if (${probes.mcpSchema}) api.registerTool({
      name: "${MCP_SCHEMA_PROBE_TOOL_NAME}",
      description: "Live test no-argument tool for MCP schema normalization",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "${resultToken}" }] };
      },
    });
  },
};
`,
  );
  return { pluginPath: pluginDir, resultToken };
}

export function prepareClaudeCacheProbeBackend(params: {
  config: OpenClawConfig;
  liveBackend: RuntimeBackendEntry;
  providerId: string;
}): RuntimeBackendEntry {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY_OLD?.trim();
  if (!apiKey) {
    throw new Error("Claude CLI cache probe requires an Anthropic API key");
  }
  // Exercise the profile-owned secret-input path in this test's isolated state.
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [CLI_CACHE_AUTH_PROFILE_ID]: {
          type: "api_key",
          provider: "claude-cli",
          key: apiKey,
        },
      },
      order: { "claude-cli": [CLI_CACHE_AUTH_PROFILE_ID] },
    },
    resolveAgentDir(params.config, "dev"),
    { syncExternalCli: false },
  );

  // Minimal test startup needs the production Gateway's owning plugin loaded explicitly.
  const registry = loadOpenClawPlugins({
    cache: false,
    config: params.config,
    onlyPluginIds: ["anthropic"],
  });
  const registration = registry.cliBackends.find((entry) => entry.backend.id === params.providerId);
  if (!registration) {
    const pluginStates = registry.plugins
      .map((plugin) => `${plugin.id}:${plugin.status}${plugin.error ? ` (${plugin.error})` : ""}`)
      .join(", ");
    throw new Error(
      `cache probe could not load runtime CLI backend ${params.providerId}; plugins=${pluginStates || "none"}`,
    );
  }
  return {
    ...registration.backend,
    // Keep the installed command/key passthrough, but use the plugin's real prepare/argv hooks.
    config: params.liveBackend.config,
    pluginId: registration.pluginId,
    ...(registration.builtWithOpenClawVersion
      ? { builtWithOpenClawVersion: registration.builtWithOpenClawVersion }
      : {}),
  };
}

async function waitFor<T>(resolve: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const value = await resolve();
    if (value !== undefined) {
      return value;
    }
    await sleep(1_000);
  }
  throw new Error("timed out waiting for live CLI announce proof");
}

export async function verifyCliBackendAnnounceOrdering({
  client,
  announceBarrier: barrier,
  requestTimeoutMs,
  logStep,
}: {
  client: GatewayClient;
  announceBarrier: Awaited<ReturnType<typeof createCliAnnounceBarrier>>;
  requestTimeoutMs: number;
  logStep: (step: string, details?: Record<string, unknown>) => void;
}) {
  const nonce = randomBytes(3).toString("hex").toUpperCase();
  const sessionKey = `agent:dev:cli-announce-${nonce.toLowerCase()}`;
  const childToken = `CLI_ANNOUNCE_CHILD_${nonce}`;
  const parentToken = `CLI_ANNOUNCE_PARENT_${nonce}`;
  let parentObservedAt: number | undefined;
  const request = client.request(
    "agent",
    {
      sessionKey,
      idempotencyKey: `cli-announce-order-${randomUUID()}`,
      deliver: false,
      timeout: 240,
      message: [
        "Run this exact OpenClaw CLI-backed completion announcement scenario. Use tool calls, not prose.",
        `Call sessions_spawn exactly once with taskName=cli_announce_${nonce.toLowerCase()} and task=${JSON.stringify(`Reply exactly ${childToken} and nothing else.`)}.`,
        `After sessions_spawn returns status=accepted, call ${CLI_ANNOUNCE_BARRIER_TOOL_NAME} exactly once with no arguments.`,
        `After that tool returns, reply exactly ${parentToken}.`,
        `When the child's completion is delivered in a later turn, include its exact result ${childToken} in your user-facing update.`,
      ].join("\n"),
    },
    { expectFinal: true, timeoutMs: requestTimeoutMs },
  );
  let requestError: unknown;
  void request.then(
    () => (parentObservedAt = Date.now()),
    (error: unknown) => (requestError = error),
  );

  const completedChild = await waitFor(() => {
    if (requestError) {
      throw new Error("CLI announce parent failed", { cause: requestError });
    }
    if (barrier.calls === 0) {
      return undefined;
    }
    return listSubagentRunsForRequester(sessionKey).find(
      (run) =>
        run.taskName === `cli_announce_${nonce.toLowerCase()}` &&
        run.completion?.resultText?.includes(childToken) === true &&
        run.execution.outcome?.status === "ok",
    );
  });
  expect(barrier.calls).toBe(1);
  expect(parentObservedAt).toBeUndefined();
  expect(completedChild.delivery?.announcedAt).toBeUndefined();
  logStep("announce-child:completed-before-parent", {
    runId: completedChild.runId,
    childEndedAt: completedChild.execution.endedAt,
    delivery: completedChild.delivery,
  });
  barrier.release();
  const parent = await request;
  parentObservedAt ??= Date.now();
  expect(extractPayloadText(parent.result)).toContain(parentToken);

  const deliveredChild = await waitFor(() =>
    listSubagentRunsForRequester(sessionKey).find(
      (run) =>
        run.runId === completedChild.runId &&
        run.delivery?.status === "delivered" &&
        typeof run.delivery?.deliveredAt === "number" &&
        typeof run.delivery?.announcedAt === "number",
    ),
  );
  expect(deliveredChild.delivery?.announcedAt).toBeGreaterThanOrEqual(parentObservedAt);
  expect(deliveredChild.delivery?.announcedAt).toBe(deliveredChild.delivery?.deliveredAt);
  // CLI requesters use an ordered agent handoff, not the embedded steer queue.
  // The committed parent reply must precede the completion in canonical history.
  const entry = (await loadGatewaySessionEntryReadOnlyAsync(sessionKey)).entry;
  if (!entry?.sessionId) {
    throw new Error("CLI announce probe lost its requester session");
  }
  const sessionTarget = await resolveSessionTranscriptRuntimeTarget({
    agentId: "dev",
    sessionId: entry.sessionId,
    sessionKey,
  });
  const { parentReplyIndex, completionReplyIndex } = await waitFor(async () => {
    const history = await loadCliSessionHistoryMessages({ sessionTarget });
    const replies = history.flatMap((message) => {
      const record = message as { role?: unknown; content?: unknown };
      return record.role === "assistant"
        ? [extractTextFromChatContent(record.content, { joinWith: "" }) ?? ""]
        : [];
    });
    const parentIndex = replies.findIndex((reply) => reply.includes(parentToken));
    const completionIndex = replies.findIndex((reply) => reply.includes(childToken));
    return parentIndex >= 0 && completionIndex >= 0
      ? { parentReplyIndex: parentIndex, completionReplyIndex: completionIndex }
      : undefined;
  });
  logStep("announce-child:transcript-order", {
    runId: deliveredChild.runId,
    parentObservedAt,
    delivery: deliveredChild.delivery,
    parentReplyIndex,
    completionReplyIndex,
  });
  expect(parentReplyIndex).toBeGreaterThanOrEqual(0);
  expect(completionReplyIndex).toBeGreaterThan(parentReplyIndex);
}
