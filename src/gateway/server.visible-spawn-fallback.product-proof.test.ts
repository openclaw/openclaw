// Exercise registered sessions_spawn through real Gateway, storage, and provider HTTP.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { buildCliMcpGrantContext } from "../agents/cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as backoff from "../infra/backoff.js";
import { requestHeartbeatAndWait } from "../infra/heartbeat-wake.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { resolveMcpRequestContext } from "./mcp-http.request.js";
import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const PRIMARY = "proof-primary/primary";
const BACKUP = "proof-backup/backup";
const CHILD_BACKUP = "proof-backup/child-backup";
const PROFILE = "proof-primary:preferred";
const WORKER = "SPAWN-FALLBACK-WORKER";
const SUCCESS = "SPAWN-FALLBACK-SUCCESS";
const INITIAL_SUCCESS = "SPAWN-INITIAL-SUCCESS";
type Receipt = { status: string; runId: string; childSessionKey: string };
type History = { messages: Array<{ role?: string; content?: unknown; stopReason?: string }> };
type ProviderRequest = {
  model: string;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
  tools?: unknown[];
  instructions?: string;
};
type Scenario = {
  name: string;
  inherited?: boolean;
  visible?: false;
  model?: string;
  configuredProfile?: boolean;
  configuredAlias?: boolean;
  emptyFallbacks?: boolean;
  backup?: string;
  directAgent?: boolean;
  directModel?: string;
};

async function startProvider(scenario: Scenario) {
  const requests: Array<{
    model: string;
    child: boolean;
    authorization?: string;
    toolCount: number;
    hasInstructions: boolean;
  }> = [];
  const errors: unknown[] = [];
  let spawn: Receipt | undefined;
  let spawnRequested = false;
  let primaryRateLimited = !scenario.directAgent;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = (await json(request)) as ProviderRequest;
      const child = JSON.stringify(body.input.filter((item) => item.role === "user")).includes(
        WORKER,
      );
      const title = JSON.stringify(
        body.input.filter((item) => item.role === "developer" || item.role === "system"),
      ).includes("Generate a concise session title");
      requests.push({
        model: body.model,
        child: child && !title,
        toolCount: body.tools?.length ?? 0,
        hasInstructions: typeof body.instructions === "string",
        authorization: request.headers.authorization,
      });
      if (child && !title && body.model === "primary" && primaryRateLimited) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Rate limit exceeded for primary",
              type: "rate_limit_exceeded",
              code: "rate_limit_exceeded",
            },
          }),
        );
        return;
      }
      const output = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_qa_spawn",
      )?.output;
      if (output) {
        spawn = JSON.parse(output) as Receipt;
      }
      if (title || child || spawnRequested) {
        if (!title && !child && !spawn) {
          errors.push(new Error("Missing sessions_spawn receipt"));
        }
        writeOpenAiResponsesText(response, {
          text: title
            ? "Fallback proof"
            : child
              ? primaryRateLimited
                ? SUCCESS
                : INITIAL_SUCCESS
              : "Parent complete",
          messageId: `msg_${requests.length}`,
          responseId: `resp_${requests.length}`,
        });
        return;
      }
      spawnRequested = true;
      const item = {
        type: "function_call",
        id: "fc_call_qa_spawn",
        call_id: "call_qa_spawn",
        name: "sessions_spawn",
        arguments: JSON.stringify({
          task: `Return exactly ${SUCCESS}. ${WORKER}`,
          visible: scenario.visible !== false,
          mode: "run",
          expectsCompletionMessage: false,
          ...(scenario.model ? { model: scenario.model } : {}),
        }),
      };
      writeOpenAiResponsesSse(response, [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_spawn",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    get spawn() {
      return spawn;
    },
    rateLimitPrimary() {
      primaryRateLimited = true;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function providerConfig(baseUrl: string, ids: string[]) {
  return {
    baseUrl,
    apiKey: "synthetic-key",
    api: "openai-responses" as const,
    request: { allowPrivateNetwork: true },
    models: ids.map((id) => ({
      id,
      name: id,
      api: "openai-responses" as const,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    })),
  };
}

const scenarios: Scenario[] = [
  { name: "configured agent ladder", backup: "backup" },
  { name: "configured qualified alias", configuredAlias: true, backup: "backup" },
  { name: "inherited primary with distinct child ladder", inherited: true, backup: "child-backup" },
  // Configured profiles express an auth retry preference; a caller's model is a strict pin.
  { name: "configured profile preference", configuredProfile: true, backup: "backup" },
  { name: "explicit model pin", model: PRIMARY },
  { name: "explicit model and profile pin", model: `${PRIMARY}@${PROFILE}` },
  { name: "explicit empty child ladder", inherited: true, emptyFallbacks: true },
  { name: "hidden child control", visible: false, backup: "backup" },
];

const directAgentScenarios: Scenario[] = [
  {
    name: "direct agent distinct child ladder",
    directAgent: true,
    backup: "child-backup",
  },
  {
    name: "direct agent empty child ladder",
    directAgent: true,
    emptyFallbacks: true,
  },
  {
    name: "direct agent explicit model pin",
    directAgent: true,
    directModel: PRIMARY,
  },
];

function drainHeartbeatWakes() {
  // The global immediate wake settles older delayed notices before this Gateway closes.
  return requestHeartbeatAndWait({
    source: "manual",
    intent: "immediate",
    reason: "wake",
    coalesceMs: 0,
  });
}

// Each Gateway owns a fresh state directory; completed children must not cross fixtures.
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

describe("sessions_spawn model fallback through the Gateway", () => {
  let retrySleep: MockInstance<typeof backoff.sleepWithAbort>;
  beforeAll(() => {
    const sleepWithAbort = backoff.sleepWithAbort;
    // Exercise every retry, including abortable waits, without real provider backoff.
    retrySleep = vi
      .spyOn(backoff, "sleepWithAbort")
      .mockImplementation((ms, signal, options) =>
        sleepWithAbort(Math.min(ms, 1), signal, options),
      );
  });
  afterAll(() => {
    retrySleep.mockRestore();
    resetGatewayTestState();
  });
  it.each([...scenarios, ...directAgentScenarios])(
    "$name",
    async (scenario) => {
      resetGatewayTestState();
      const home = await setupGatewayTempHome({ prefix: "openclaw-spawn-fallback-" });
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          provider = await startProvider(scenario);
          const token = randomUUID();
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
          const primary = scenario.configuredAlias
            ? "proof-primary/fast"
            : scenario.configuredProfile
              ? `${PRIMARY}@${PROFILE}`
              : PRIMARY;
          const ladder = { primary, fallbacks: [BACKUP] };
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: home.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                ...(scenario.inherited ? { model: ladder } : {}),
                subagents: {
                  allowAgents: ["*"],
                  maxConcurrent: 2,
                  ...(scenario.inherited || scenario.emptyFallbacks || scenario.directAgent
                    ? { model: { fallbacks: scenario.emptyFallbacks ? [] : [CHILD_BACKUP] } }
                    : {}),
                },
                models: Object.fromEntries(
                  [PRIMARY, BACKUP, CHILD_BACKUP].map((ref) => [
                    ref,
                    {
                      ...(scenario.configuredAlias && ref === PRIMARY ? { alias: "fast" } : {}),
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  ]),
                ),
              },
              ...(!scenario.inherited ? { entries: { main: { model: ladder } } } : {}),
            },
            models: {
              mode: "replace",
              providers: {
                "proof-primary": providerConfig(provider.baseUrl, ["primary"]),
                "proof-backup": providerConfig(provider.baseUrl, ["backup", "child-backup"]),
              },
            },
            // The provider scripts a direct spawn to isolate the child's model fallback ladder.
            tools: { profile: "coding", toolSearch: false },
            gateway: { auth: { mode: "token", token } },
            hooks: { enabled: false },
          };
          const agentDir = resolveAgentDir(cfg, "main");
          await fs.mkdir(agentDir, { recursive: true });
          // This proof owns model fallback, while transient retry pacing has focused coverage.
          await fs.writeFile(
            path.join(agentDir, "settings.json"),
            `${JSON.stringify({ retry: { provider: { maxRetries: 0 } } })}\n`,
            "utf8",
          );
          if (scenario.configuredProfile || scenario.model?.includes("@")) {
            upsertAuthProfile({
              agentDir,
              profileId: PROFILE,
              credential: {
                type: "api_key",
                provider: "proof-primary",
                key: "synthetic-profile-key",
              },
            });
          }
          const port = await getGatewayE2ePortBlock();
          let onSessionChanged: (payload: unknown) => void = () => {};
          gateway = await startGatewayWithClient({
            cfg,
            port,
            clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            origin: `http://127.0.0.1:${port}`,
            configPath: await createGatewayConfigPath(home.tempHome),
            token,
            onEvent: ({ event, payload }) => {
              if (event === "sessions.changed") {
                onSessionChanged(payload);
              }
            },
          });
          await gateway.server.startupSettled;
          const { client } = gateway;
          const parentKey = `agent:main:proof-${randomUUID()}`;
          const accepted = await client.request<{ runId: string; status: string }>(
            "chat.send",
            {
              sessionKey: parentKey,
              message: "Spawn one worker now.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: false },
          );
          expect(accepted.status).toBe("started");
          const wait = (runId: string) =>
            client.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: 240_000 },
              { timeoutMs: 245_000 },
            );
          expect((await wait(accepted.runId)).status, JSON.stringify(provider.requests)).toBe("ok");
          if (scenario.configuredAlias) {
            expect(provider.requests.filter((request) => !request.child)).toContainEqual(
              expect.objectContaining({ model: "primary" }),
            );
            expect(provider.requests.some((request) => request.model === "fast")).toBe(false);
          }
          expect(provider.spawn).toMatchObject({
            status: "accepted",
            childSessionKey: expect.any(String),
            runId: expect.any(String),
          });
          const spawn = provider.spawn;
          if (!spawn) {
            throw new Error("Parent did not receive the sessions_spawn result");
          }
          let terminal = await wait(spawn.runId);
          let requestOffset = 0;
          let historyOffset = 0;
          if (scenario.directAgent) {
            expect(terminal.status).toBe("ok");
            const initialHistory = await client.request<History>("chat.history", {
              sessionKey: spawn.childSessionKey,
              limit: 100,
            });
            const initialReplies = initialHistory.messages.filter(
              (message) => message.role === "assistant",
            );
            expect(
              initialReplies.map((message) => extractTextFromChatContent(message.content)),
            ).toEqual([INITIAL_SUCCESS]);
            expect(
              new Set(
                provider.requests.filter((request) => request.child).map(({ model }) => model),
              ),
            ).toEqual(new Set(["primary"]));
            historyOffset = initialHistory.messages.length;
            requestOffset = provider.requests.length;
            provider.rateLimitPrimary();
            const followupRunId = randomUUID();
            const publishedIdle = createDeferred();
            onSessionChanged = (payload) => {
              if (
                isRecord(payload) &&
                payload.sessionKey === spawn.childSessionKey &&
                payload.lastRunId === followupRunId &&
                payload.hasActiveRun === false &&
                Array.isArray(payload.activeRunIds) &&
                payload.activeRunIds.length === 0
              ) {
                publishedIdle.resolve();
              }
            };
            await client.request("sessions.subscribe", {});
            const followup = await client.request<{ runId: string; status: string }>(
              "agent",
              {
                sessionKey: spawn.childSessionKey,
                message: `Return exactly ${SUCCESS}. ${WORKER}`,
                deliver: false,
                idempotencyKey: followupRunId,
                ...(scenario.directModel ? { model: scenario.directModel } : {}),
              },
              { expectFinal: false },
            );
            expect(followup.status).toBe("accepted");
            expect(followup.runId).toBe(followupRunId);
            terminal = await wait(followup.runId);
            await withTestTimeout(
              publishedIdle.promise,
              8_000,
              "Gateway did not publish settled child ownership after the direct turn",
            );
          }
          expect(spawn.childSessionKey).toMatch(
            scenario.visible === false ? /^agent:main:subagent:/ : /^agent:main:dashboard:/,
          );
          const { sessions } = await client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
            limit: 100,
          });
          const child = sessions.find((entry) => entry.key === spawn.childSessionKey);
          expect(child).toMatchObject({ hasActiveRun: false });
          if (scenario.visible !== false) {
            expect(child).toMatchObject({ parentSessionKey: parentKey });
          }
          const history = await client.request<History>("chat.history", {
            sessionKey: spawn.childSessionKey,
            limit: 100,
          });
          const replies = history.messages
            .slice(historyOffset)
            .filter((message) => message.role === "assistant");
          const text = replies
            .map((message) => extractTextFromChatContent(message.content))
            .join("\n");
          const entry = loadSessionEntryReadOnly({
            sessionKey: spawn.childSessionKey,
            agentId: "main",
          });
          const childRequests = provider.requests
            .slice(requestOffset)
            .filter((request) => request.child);
          console.info(
            JSON.stringify({
              scenario: scenario.name,
              ...(scenario.directAgent
                ? { initialChildReply: INITIAL_SUCCESS, requestOffset, historyOffset }
                : {}),
              childRequests: childRequests.map(({ model }) => model),
              ...(scenario.configuredAlias
                ? {
                    parentRequests: provider.requests
                      .filter((request) => !request.child)
                      .map(({ model }) => model),
                  }
                : {}),
              terminal,
              childSessionKey: spawn.childSessionKey,
              modelOverrideSource: entry?.modelOverrideSource,
              modelOverride: entry?.modelOverride,
              childHistory: text,
            }),
          );
          expect(terminal.status, JSON.stringify(provider.requests)).toBe(
            scenario.backup ? "ok" : "error",
          );
          expect(entry?.modelOverrideSource).toBe(scenario.model ? "user" : "auto");
          if (!scenario.model && !scenario.inherited) {
            expect(entry).toMatchObject({
              modelOverrideFallbackOriginProvider: "proof-primary",
              modelOverrideFallbackOriginModel: "primary",
            });
          }
          expect(childRequests).toContainEqual(expect.objectContaining({ model: "primary" }));
          expect(childRequests.filter((request) => request.model === "primary")).toHaveLength(1);
          expect(provider.errors).toEqual([]);
          if (scenario.backup) {
            expect(childRequests.map((request) => request.model)).toContain(scenario.backup);
            expect(text).toContain(SUCCESS);
            if (scenario.inherited || scenario.directAgent) {
              expect(childRequests.map((request) => request.model)).not.toContain("backup");
            }
          } else {
            expect(childRequests.every((request) => request.model === "primary")).toBe(true);
            expect(text).not.toContain(SUCCESS);
            expect(replies).toContainEqual(expect.objectContaining({ stopReason: "error" }));
            expect(entry).toMatchObject({
              modelOverride: "primary",
              providerOverride: "proof-primary",
            });
          }
          if (scenario.configuredProfile || scenario.model?.includes("@")) {
            expect(childRequests).toContainEqual(
              expect.objectContaining({
                model: "primary",
                authorization: "Bearer synthetic-profile-key",
              }),
            );
            if (scenario.model) {
              expect(entry).toMatchObject({
                authProfileOverride: PROFILE,
                authProfileOverrideSource: "user",
              });
            }
            expect(entry?.modelOverride).not.toContain("@");
          }
        },
        () => gateway && drainHeartbeatWakes(),
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "spawn fallback proof complete" }),
        () => provider?.stop(),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        resetGatewayTestState,
      );
    },
    600_000,
  );
});

async function withCliSpawnGrant(
  params: {
    cfg: OpenClawConfig;
    parentKey: string;
    parentSessionId: string;
    workspaceDir: string;
    nativeModel: string;
    visible: boolean;
  },
  verify: (spawn: Receipt) => Promise<void>,
) {
  const runId = randomUUID();
  const admission = prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "cli-model-inheritance-proof", state: "present" },
    },
  });
  let grantToken: string | undefined;
  try {
    const admittedRunContext = await admission.admit("embedded");
    const run = {
      sessionId: params.parentSessionId,
      sessionKey: params.parentKey,
      sessionFile: path.join(params.workspaceDir, "cli-parent.jsonl"),
      workspaceDir: params.workspaceDir,
      provider: "claude-cli",
      model: params.nativeModel,
      requesterModel: { provider: "proof-primary", model: "primary" },
      modelHasVision: false,
      senderIsOwner: true,
      runId,
      prompt: "Spawn one child using this turn's selected model.",
      timeoutMs: 240_000,
    } satisfies RunCliAgentParams;
    const grant = mintMcpLoopbackClientGrant({
      context: buildCliMcpGrantContext({
        run,
        config: params.cfg,
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "proof-primary",
        modelId: params.nativeModel,
        toolsAllow: ["read", "sessions_spawn"],
      }),
      runtimeOwnerToken: runId,
      admittedRunContext,
    });
    grantToken = grant.token;
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runId,
        captureKey: runId,
      }),
    ).toBeTruthy();
    run.requesterModel.model = "later-input-mutation";
    const currentGrant = resolveMcpLoopbackClientGrant({
      token: grant.token,
      runtimeOwnerToken: runId,
      captureKey: runId,
    });
    if (!currentGrant) {
      throw new Error("CLI proof grant is not active");
    }
    const request = new IncomingMessage(new Socket());
    const context = resolveMcpRequestContext(request, params.cfg, {
      senderIsOwner: true,
      boundClientGrant: currentGrant,
      boundGrantToken: grant.token,
    });
    request.destroy();
    const scoped = await resolveMcpLoopbackScopedTools({
      cfg: params.cfg,
      context,
      grantToken: grant.token,
      isGrantCurrent: currentGrant.isCurrent,
    });
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: currentGrant.admittedRunContext,
      receiptAuthority: currentGrant.isCurrent,
      agentId: scoped.agentId,
      sessionKey: context.sessionKey,
    });
    const response = await withGatewayToolCallerIdentity(caller, () =>
      handleMcpJsonRpc({
        message: {
          jsonrpc: "2.0",
          id: "cli-model-inheritance",
          method: "tools/call",
          params: {
            name: "sessions_spawn",
            arguments: {
              task: `Return exactly ${INITIAL_SUCCESS}. ${WORKER}`,
              label: "CLI child",
              visible: params.visible,
              expectsCompletionMessage: false,
            },
          },
        },
        tools: scoped.tools,
        toolSchema: buildMcpToolSchema(scoped.tools),
        hookContext: { config: params.cfg, agentId: "main", sessionKey: params.parentKey },
        authorizeToolCall: currentGrant.isCurrent,
      }),
    );
    expect(response, JSON.stringify(response)).toMatchObject({
      result: { isError: false, content: [{ type: "text", text: expect.any(String) }] },
    });
    const payload = response as { result: { content: Array<{ type: string; text: string }> } };
    const spawn = JSON.parse(payload.result.content[0]!.text) as Receipt;
    expect(spawn).toMatchObject({ status: "accepted", runId: expect.any(String) });
    await verify(spawn);
  } finally {
    if (grantToken) {
      revokeMcpLoopbackClientGrant(grantToken);
    }
    admission.close();
  }
}

describe("CLI model inheritance through MCP", () => {
  afterAll(resetGatewayTestState);
  it.each(
    [false, true].flatMap((visible) =>
      ["alias", "primary[1m]"].map((nativeModel) => ({ visible, nativeModel })),
    ),
  )(
    "inherits the logical model with visible=$visible and native=$nativeModel",
    async (scenario) => {
      resetGatewayTestState();
      const home = await setupGatewayTempHome({ prefix: "openclaw-cli-model-inheritance-" });
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          provider = await startProvider({ name: "CLI model inheritance", directAgent: true });
          const token = randomUUID();
          const port = await getGatewayE2ePortBlock();
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: home.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: BACKUP,
                models: {
                  [PRIMARY]: { params: { transport: "sse", openaiWsWarmup: false } },
                  [BACKUP]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
                subagents: { allowAgents: ["*"] },
              },
            },
            models: {
              mode: "replace",
              providers: {
                "proof-primary": providerConfig(provider.baseUrl, ["primary"]),
                "proof-backup": providerConfig(provider.baseUrl, ["backup"]),
              },
            },
            tools: { profile: "coding" },
            gateway: { port, auth: { mode: "token", token } },
            hooks: { enabled: false },
          };
          gateway = await startGatewayWithClient({
            cfg,
            port,
            token,
            configPath: await createGatewayConfigPath(home.tempHome),
          });
          await gateway.server.startupSettled;
          const { client } = gateway;
          const parentKey = `agent:main:cli-model-proof:${randomUUID()}`;
          await client.request("sessions.patch", { key: parentKey, model: BACKUP });
          const parent = loadSessionEntryReadOnly({ agentId: "main", sessionKey: parentKey });
          if (!parent?.sessionId) {
            throw new Error("CLI proof parent was not created");
          }
          const providerRequests = provider.requests;
          await withCliSpawnGrant(
            {
              cfg,
              parentKey,
              parentSessionId: parent.sessionId,
              workspaceDir: home.workspaceDir,
              ...scenario,
            },
            async (spawn) => {
              const terminal = await client.request<{ status: string }>(
                "agent.wait",
                { runId: spawn.runId, timeoutMs: 240_000 },
                { timeoutMs: 245_000 },
              );
              expect(terminal.status).toBe("ok");
              const childRequests = providerRequests.filter((request) => request.child);
              expect(childRequests.length).toBeGreaterThan(0);
              expect(
                childRequests.every((request) => request.model === "primary"),
                JSON.stringify(
                  childRequests.map(({ model, toolCount, hasInstructions }) => ({
                    model,
                    toolCount,
                    hasInstructions,
                  })),
                ),
              ).toBe(true);
              const child = loadSessionEntryReadOnly({
                agentId: "main",
                sessionKey: spawn.childSessionKey,
              });
              expect(child).toMatchObject({
                providerOverride: "proof-primary",
                modelOverride: "primary",
                modelOverrideSource: "auto",
                spawnedBy: parentKey,
                spawnDepth: 1,
              });
              expect(
                loadSessionEntryReadOnly({ agentId: "main", sessionKey: parentKey }),
              ).toMatchObject({
                providerOverride: "proof-backup",
                modelOverride: "backup",
                modelOverrideSource: "user",
              });
              const transcript = await client.request<History>("chat.history", {
                sessionKey: spawn.childSessionKey,
                limit: 100,
              });
              expect(
                transcript.messages
                  .filter((message) => message.role === "assistant")
                  .map((message) => extractTextFromChatContent(message.content)),
              ).toContain(INITIAL_SUCCESS);
              console.info(
                JSON.stringify({
                  proof: "CLI model inheritance through MCP",
                  ...scenario,
                  savedParent: BACKUP,
                  activeLogicalModel: PRIMARY,
                  childModels: childRequests.map((request) => request.model),
                  terminal: terminal.status,
                }),
              );
            },
          );
          expect(provider.errors).toEqual([]);
        },
        () => gateway && drainHeartbeatWakes(),
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "CLI model inheritance proof complete" }),
        () => provider?.stop(),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        resetGatewayTestState,
      );
    },
    600_000,
  );
});
