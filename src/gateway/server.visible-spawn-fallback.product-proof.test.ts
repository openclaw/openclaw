// Exercise registered sessions_spawn through real Gateway, storage, and provider HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeRestartToolCall } from "../../test/gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfileAsync } from "../agents/auth-profiles.js";
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
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
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
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock } from "./test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const PRIMARY = "proof-primary/primary";
const BACKUP = "proof-backup/backup";
const CHILD_BACKUP = "proof-backup/child-backup";
const PROFILE = "proof-primary:preferred";
const WORKER = "SPAWN-FALLBACK-WORKER";
const SUCCESS = "SPAWN-FALLBACK-SUCCESS";
const INITIAL_SUCCESS = "SPAWN-INITIAL-SUCCESS";
const primaryOverride = { modelOverride: "primary", providerOverride: "proof-primary" };
type Receipt = { status: string; runId: string; childSessionKey: string };
type History = {
  messages: Array<{
    role?: string;
    content?: unknown;
    openclawRunError?: { runId: string; summary: string };
  }>;
};
type ProviderRequest = {
  model: string;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
};
type Scenario = {
  name: string;
  cli?: boolean;
  inherited?: boolean;
  visible?: false;
  model?: string;
  configuredProfile?: boolean;
  configuredAlias?: boolean;
  emptyFallbacks?: boolean;
  backup?: string;
  directAgent?: boolean;
  directModel?: string;
  stopControl?: "typed" | "session";
};

async function startProvider(scenario: Scenario) {
  const requests: Array<{
    model: string;
    child: boolean;
    authorization?: string;
    waitingInput: boolean;
  }> = [];
  const errors: unknown[] = [];
  let spawn: Receipt | undefined;
  let spawnRequested = false;
  let primaryRateLimited = !scenario.directAgent;
  const parentHeld = createDeferred();
  const childHeld = createDeferred();
  const releaseControl = createDeferred();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const { model, input } = (await json(request)) as ProviderRequest;
        const userInput = JSON.stringify(input.filter((item) => item.role === "user"));
        const child = userInput.includes(WORKER);
        const title = JSON.stringify(
          input.filter((item) => item.role === "developer" || item.role === "system"),
        ).includes("Generate a concise session title");
        const { authorization } = request.headers;
        requests.push({
          model,
          child: child && !title,
          authorization,
          waitingInput:
            !title && userInput.includes("This waiting input must not reach inference after Stop"),
        });
        if (requests.at(-1)?.waitingInput) {
          throw new Error("Cancelled waiting input reached inference");
        }
        if (child && !title && model === "primary" && primaryRateLimited) {
          response.writeHead(429, { "content-type": "application/json" });
          const type = "rate_limit_exceeded";
          const error = { message: "Rate limit exceeded for primary", type, code: type };
          response.end(JSON.stringify({ error }));
          return;
        }
        const output = input.find(
          (item) => item.type === "function_call_output" && item.call_id === "call_qa_0",
        )?.output;
        if (output) {
          spawn = JSON.parse(output) as Receipt;
        }
        if (title || child || spawnRequested) {
          if (!title && !child && !spawn) {
            errors.push(new Error("Missing sessions_spawn receipt"));
          }
          if (scenario.stopControl && !title) {
            (child ? childHeld : parentHeld).resolve();
            await releaseControl.promise;
            if (response.destroyed) {
              return;
            }
          }
          const childText = primaryRateLimited ? SUCCESS : INITIAL_SUCCESS;
          writeOpenAiResponsesText(response, {
            text: title ? "Fallback proof" : child ? childText : "Parent complete",
            messageId: `msg_${requests.length}`,
            responseId: `resp_${requests.length}`,
          });
          return;
        }
        spawnRequested = true;
        const spawnArgs = {
          task: `Return exactly ${SUCCESS}. ${WORKER}`,
          visible: scenario.visible !== false,
          mode: "run",
          expectsCompletionMessage: false,
          ...(scenario.model ? { model: scenario.model } : {}),
        };
        writeRestartToolCall(response, "qa", "sessions_spawn", spawnArgs, 0);
      } catch (error) {
        errors.push(error);
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      }
    })();
  });
  return {
    baseUrl: await listenProvider(server),
    requests,
    errors,
    get spawn() {
      return spawn;
    },
    rateLimitPrimary() {
      primaryRateLimited = true;
    },
    controlSourcesHeld: Promise.all([parentHeld.promise, childHeld.promise]),
    releaseHeldResponses: () => releaseControl.resolve(),
    stop: () => {
      releaseControl.resolve();
      return closeProvider(server);
    },
  };
}

function providerConfig(baseUrl: string, ids: string[]) {
  return {
    ...buildMockOpenAiResponsesProvider(baseUrl).config,
    apiKey: "synthetic-key",
    request: { allowPrivateNetwork: true },
    models: ids.map((id) => buildMockOpenAiResponsesProvider(baseUrl, id).config.models[0]),
  };
}

async function withProofGateway(
  scenario: Scenario,
  verify: (fixture: {
    cfg: OpenClawConfig;
    workspaceDir: string;
    provider: Awaited<ReturnType<typeof startProvider>>;
    client: GatewayClient;
    onSessionChanged: (listener: (payload: unknown) => void) => void;
  }) => Promise<void>,
) {
  resetGatewayTestState();
  const prefix = scenario.cli ? "openclaw-cli-model-inheritance-" : "openclaw-spawn-fallback-";
  const home = await setupGatewayTempHome({ prefix });
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  await runQaGatewayFixture(
    async () => {
      provider = await startProvider(scenario);
      const token = randomUUID();
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const claim = await acquireGatewayE2ePortBlock();
      const primary = scenario.configuredAlias
        ? "proof-primary/fast"
        : scenario.configuredProfile
          ? `${PRIMARY}@${PROFILE}`
          : PRIMARY;
      const ladder = { primary, fallbacks: [BACKUP] };
      const childLadder =
        !scenario.cli && (scenario.inherited || scenario.emptyFallbacks || scenario.directAgent);
      const params = { transport: "sse", openaiWsWarmup: false };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: home.workspaceDir,
            skipBootstrap: true,
            model: scenario.cli ? CHILD_BACKUP : scenario.inherited ? ladder : undefined,
            models: Object.fromEntries(
              [PRIMARY, BACKUP, CHILD_BACKUP].map((ref) => [
                ref,
                {
                  ...(scenario.configuredAlias && ref === PRIMARY ? { alias: "fast" } : {}),
                  params: { ...params },
                },
              ]),
            ),
            subagents: {
              allowAgents: ["*"],
              maxConcurrent: scenario.cli ? undefined : 2,
              model: childLadder
                ? { fallbacks: scenario.emptyFallbacks ? [] : [CHILD_BACKUP] }
                : undefined,
            },
          },
          ...(!scenario.cli && !scenario.inherited ? { entries: { main: { model: ladder } } } : {}),
        },
        models: {
          mode: "replace",
          providers: {
            "proof-primary": providerConfig(provider.baseUrl, ["primary"]),
            "proof-backup": providerConfig(provider.baseUrl, ["backup", "child-backup"]),
          },
        },
        tools: { profile: "coding", ...(!scenario.cli ? { toolSearch: false } : {}) },
        gateway: { auth: { mode: "token", token }, ...(scenario.cli ? { port: claim.port } : {}) },
        hooks: { enabled: false },
      };
      if (!scenario.cli) {
        // Retry pacing has focused coverage; this fixture proves model fallback.
        const agentDir = resolveAgentDir(cfg, "main");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "settings.json"),
          `${JSON.stringify({ retry: { provider: { maxRetries: 0 } } })}\n`,
          "utf8",
        );
        if (scenario.configuredProfile || scenario.model?.includes("@")) {
          await upsertAuthProfileAsync({
            agentDir,
            profileId: PROFILE,
            credential: {
              type: "api_key",
              provider: "proof-primary",
              key: "synthetic-profile-key",
            },
          });
        }
      }
      let onSessionChanged = (_payload: unknown) => {};
      gateway = await startGatewayWithClient({
        cfg,
        portClaim: claim,
        token,
        configPath: await createGatewayConfigPath(home.tempHome),
        ...(!scenario.cli
          ? {
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              origin: `http://127.0.0.1:${claim.port}`,
              onEvent: ({ event, payload }: { event?: string; payload?: unknown }) => {
                if (event === "sessions.changed") {
                  onSessionChanged(payload);
                }
              },
            }
          : {}),
      });
      await gateway.server.startupSettled;
      await verify({
        cfg,
        workspaceDir: home.workspaceDir,
        provider,
        client: gateway.client,
        onSessionChanged: (listener) => {
          onSessionChanged = listener;
        },
      });
    },
    // Cleanup wakes may call the provider too; release response holds before joining them.
    () => provider?.releaseHeldResponses(),
    // Flush older delayed notices before this Gateway closes.
    () =>
      gateway &&
      requestHeartbeatAndWait({
        source: "manual",
        intent: "immediate",
        reason: "wake",
        coalesceMs: 0,
      }),
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: `${prefix} complete` }),
    () => provider?.stop(),
    () => removeGatewayTempHome(home.tempHome),
    () => home.envSnapshot.restore(),
    resetGatewayTestState,
  );
}

type GatewayClient = Awaited<ReturnType<typeof startGatewayWithClient>>["client"];
const waitForRun = (client: GatewayClient, runId: string) =>
  client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs: 240_000 },
    { timeoutMs: 245_000 },
  );
const readHistory = (client: GatewayClient, sessionKey: string) =>
  client.request<History>("chat.history", { sessionKey, limit: 100 });
const readEntry = (sessionKey: string) => loadSessionEntryReadOnly({ agentId: "main", sessionKey });
const assistantTexts = (messages: History["messages"]) =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => extractTextFromChatContent(message.content));

const scenarios: Scenario[] = [
  {
    name: "typed Stop cancels real child and pending input",
    directAgent: true,
    stopControl: "typed",
  },
  {
    name: "session Stop cancels real child and pending input",
    directAgent: true,
    stopControl: "session",
  },
  { name: "configured agent ladder", backup: "backup" },
  { name: "configured qualified alias", configuredAlias: true, backup: "backup" },
  { name: "inherited primary with distinct child ladder", inherited: true, backup: "child-backup" },
  // Configured profiles express an auth retry preference; a caller's model is a strict pin.
  { name: "configured profile preference", configuredProfile: true, backup: "backup" },
  { name: "explicit model pin", model: PRIMARY },
  { name: "explicit model and profile pin", model: `${PRIMARY}@${PROFILE}` },
  { name: "explicit empty child ladder", inherited: true, emptyFallbacks: true },
  { name: "hidden child control", visible: false, backup: "backup" },
  { name: "direct agent distinct child ladder", directAgent: true, backup: "child-backup" },
  { name: "direct agent empty child ladder", directAgent: true, emptyFallbacks: true },
  { name: "direct agent explicit model pin", directAgent: true, directModel: PRIMARY },
];

// Each Gateway owns a fresh state directory; completed children must not cross fixtures.
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

describe("sessions_spawn model fallback through the Gateway", () => {
  let restoreRetrySleep: () => void;
  beforeAll(() => {
    const sleepWithAbort = backoff.sleepWithAbort;
    // Exercise every retry, including abortable waits, without real provider backoff.
    const retrySleep = vi
      .spyOn(backoff, "sleepWithAbort")
      .mockImplementation((ms, signal, options) =>
        sleepWithAbort(Math.min(ms, 1), signal, options),
      );
    restoreRetrySleep = () => retrySleep.mockRestore();
  });
  afterAll(() => {
    restoreRetrySleep();
    resetGatewayTestState();
  });
  it.each(scenarios)(
    "$name",
    (scenario) =>
      withProofGateway(scenario, async ({ provider, client, onSessionChanged }) => {
        const start = (method: string, params: Record<string, unknown>) =>
          client.request<{ runId: string; status: string }>(
            method,
            { deliver: false, ...params },
            { expectFinal: false },
          );
        const parentKey = `agent:main:proof-${randomUUID()}`;
        const accepted = await start("chat.send", {
          sessionKey: parentKey,
          message: "Spawn one worker now.",
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("started");
        const wait = (runId: string) => waitForRun(client, runId);
        if (scenario.stopControl) {
          await provider.controlSourcesHeld;
        } else {
          expect(await wait(accepted.runId)).toMatchObject({ status: "ok" });
        }
        const spawn = provider.spawn;
        expect(spawn).toMatchObject({
          status: "accepted",
          childSessionKey: expect.any(String),
          runId: expect.any(String),
        });
        assert(spawn, "Parent did not receive the sessions_spawn result");
        if (scenario.stopControl) {
          const pendingRunId = randomUUID();
          await client.request(
            "agent",
            {
              sessionKey: parentKey,
              message: "This waiting input must not reach inference after Stop",
              idempotencyKey: pendingRunId,
            },
            { expectFinal: false },
          );
          if (scenario.stopControl === "typed") {
            await expect(
              client.request("chat.send", {
                sessionKey: parentKey,
                message: "/stop",
                idempotencyKey: randomUUID(),
              }),
            ).resolves.toMatchObject({ ok: true, aborted: true });
          } else {
            await expect(
              client.request("sessions.abort", { key: parentKey, clearQueued: true }),
            ).resolves.toMatchObject({ ok: true, status: "aborted" });
          }
          const described = await client.request<{
            session: { status: string; hasActiveRun: boolean };
          }>("sessions.describe", { key: spawn.childSessionKey, agentId: "main" });
          expect(described.session).toMatchObject({ status: "killed", hasActiveRun: false });
          for (const runId of [accepted.runId, spawn.runId, pendingRunId]) {
            const stopped = await wait(runId);
            expect(stopped.status).not.toBe("ok");
          }
          const active = await client.request<SessionsListResult>("sessions.list", {
            activeOnly: true,
            agentId: "main",
          });
          expect(active.sessions.map((session) => session.key)).not.toContain(parentKey);
          expect(active.sessions.map((session) => session.key)).not.toContain(
            spawn.childSessionKey,
          );
          expect(provider.requests.some((request) => request.waitingInput)).toBe(false);
          expect(provider.errors).toEqual([]);
          return;
        }
        if (scenario.configuredAlias) {
          expect(provider.requests.filter((request) => !request.child)).toContainEqual(
            expect.objectContaining({ model: "primary" }),
          );
          expect(provider.requests.some((request) => request.model === "fast")).toBe(false);
        }
        const { childSessionKey: childKey } = spawn;
        let settledRunId = spawn.runId;
        let terminal = await wait(settledRunId);
        let requestOffset = 0;
        let historyOffset = 0;
        if (scenario.directAgent) {
          expect(terminal.status).toBe("ok");
          const initialHistory = await readHistory(client, childKey);
          expect(assistantTexts(initialHistory.messages)).toEqual([INITIAL_SUCCESS]);
          expect(
            new Set(provider.requests.filter((request) => request.child).map(({ model }) => model)),
          ).toEqual(new Set(["primary"]));
          historyOffset = initialHistory.messages.length;
          requestOffset = provider.requests.length;
          provider.rateLimitPrimary();
          const followupRunId = randomUUID();
          const publishedIdle = createDeferred();
          onSessionChanged((payload) => {
            if (
              isRecord(payload) &&
              payload.sessionKey === childKey &&
              payload.lastRunId === followupRunId &&
              payload.hasActiveRun === false &&
              Array.isArray(payload.activeRunIds) &&
              payload.activeRunIds.length === 0
            ) {
              publishedIdle.resolve();
            }
          });
          await client.request("sessions.subscribe", {});
          const followup = await start("agent", {
            sessionKey: childKey,
            message: `Return exactly ${SUCCESS}. ${WORKER}`,
            idempotencyKey: followupRunId,
            ...(scenario.directModel ? { model: scenario.directModel } : {}),
          });
          expect(followup).toMatchObject({ status: "accepted", runId: followupRunId });
          settledRunId = followup.runId;
          terminal = await wait(settledRunId);
          await withTestTimeout(
            publishedIdle.promise,
            8_000,
            "Gateway did not publish settled child ownership after the direct turn",
          );
        }
        expect(childKey).toMatch(
          scenario.visible === false ? /^agent:main:subagent:/ : /^agent:main:dashboard:/,
        );
        const { sessions } = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
          limit: 100,
        });
        expect(sessions.find((entry) => entry.key === childKey)).toMatchObject({
          hasActiveRun: false,
          ...(scenario.visible !== false ? { parentSessionKey: parentKey } : {}),
        });
        const history = await readHistory(client, childKey);
        const text = assistantTexts(history.messages.slice(historyOffset)).join("\n");
        const entry = readEntry(childKey);
        const childRequests = provider.requests
          .slice(requestOffset)
          .filter((request) => request.child);
        const childModels = childRequests.map((request) => request.model);
        expect(terminal).toMatchObject({ status: scenario.backup ? "ok" : "error" });
        expect(entry?.modelOverrideSource).toBe(scenario.model ? "user" : "auto");
        if (!scenario.model && !scenario.inherited) {
          expect(entry).toMatchObject({
            modelOverrideFallbackOriginProvider: "proof-primary",
            modelOverrideFallbackOriginModel: "primary",
          });
        }
        expect(childRequests.filter((request) => request.model === "primary")).toHaveLength(1);
        expect(provider.errors).toEqual([]);
        if (scenario.backup) {
          expect(childModels).toContain(scenario.backup);
          expect(text).toContain(SUCCESS);
          if (scenario.inherited || scenario.directAgent) {
            expect(childModels).not.toContain("backup");
          }
        } else {
          expect(childRequests.every((request) => request.model === "primary")).toBe(true);
          expect(text).not.toContain(SUCCESS);
          expect(
            history.messages.filter((message) => message.openclawRunError?.runId === settledRunId),
          ).toEqual([
            expect.objectContaining({
              role: "custom",
              openclawRunError: { runId: settledRunId, summary: expect.stringMatching(/\S/) },
            }),
          ]);
          expect(entry).toMatchObject(primaryOverride);
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
      }),
    600_000,
  );
});

describe("CLI model inheritance through MCP", () => {
  afterAll(resetGatewayTestState);
  it.each([
    { visible: false, nativeModel: "alias" },
    { visible: true, nativeModel: "primary[1m]" },
  ])(
    "inherits the logical model with visible=$visible and native=$nativeModel",
    ({ visible, nativeModel }) =>
      withProofGateway(
        { name: "CLI model inheritance", directAgent: true, cli: true },
        async ({ cfg, workspaceDir, provider, client }) => {
          const parentKey = `agent:main:cli-model-proof:${randomUUID()}`;
          await client.request("sessions.patch", { key: parentKey, model: BACKUP });
          const parent = readEntry(parentKey);
          assert(parent?.sessionId, "CLI proof parent was not created");
          const parentOverride = {
            providerOverride: "proof-backup",
            modelOverride: "backup",
            modelOverrideSource: "user",
          };
          expect(parent).toMatchObject(parentOverride);
          const runId = randomUUID();
          const admission = prepareSystemAgentRunAdmission(
            cfg,
            runId,
            "main",
            "cli-model-inheritance-proof",
          );
          let grantToken: string | undefined;
          try {
            const admittedRunContext = await admission.admit("embedded");
            const run = {
              sessionId: parent.sessionId,
              sessionKey: parentKey,
              sessionFile: path.join(workspaceDir, "cli-parent.jsonl"),
              workspaceDir,
              provider: "claude-cli",
              model: nativeModel,
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
                config: cfg,
                requireExplicitMessageTarget: false,
                agentId: "main",
                modelProvider: "proof-primary",
                modelId: nativeModel,
                toolsAllow: ["read", "sessions_spawn"],
              }),
              runtimeOwnerToken: runId,
              admittedRunContext,
            });
            grantToken = grant.token;
            const capture = { token: grant.token, runtimeOwnerToken: runId, captureKey: runId };
            expect(activateMcpLoopbackClientGrantCapture(capture)).toBeTruthy();
            run.requesterModel.model = "later-input-mutation";
            const currentGrant = resolveMcpLoopbackClientGrant(capture);
            assert(currentGrant, "CLI proof grant is not active");
            const httpRequest = new IncomingMessage(new Socket());
            const context = resolveMcpRequestContext(httpRequest, cfg, {
              senderIsOwner: true,
              boundClientGrant: currentGrant,
              boundGrantToken: grant.token,
            });
            httpRequest.destroy();
            const scoped = await resolveMcpLoopbackScopedTools({
              cfg,
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
                      visible,
                      expectsCompletionMessage: false,
                    },
                  },
                },
                tools: scoped.tools,
                toolSchema: buildMcpToolSchema(scoped.tools),
                hookContext: { config: cfg, agentId: "main", sessionKey: parentKey },
                authorizeToolCall: currentGrant.isCurrent,
              }),
            );
            expect(response, JSON.stringify(response)).toMatchObject({
              result: { isError: false, content: [{ type: "text", text: expect.any(String) }] },
            });
            const payload = response as {
              result: { content: Array<{ type: string; text: string }> };
            };
            const spawn = JSON.parse(payload.result.content[0]!.text) as Receipt;
            expect(spawn).toMatchObject({ status: "accepted", runId: expect.any(String) });
            expect((await waitForRun(client, spawn.runId)).status).toBe("ok");
            const childRequests = provider.requests.filter((request) => request.child);
            expect(new Set(childRequests.map((request) => request.model))).toEqual(
              new Set(["primary"]),
            );
            expect(readEntry(spawn.childSessionKey)).toMatchObject({
              ...primaryOverride,
              modelOverrideSource: "auto",
              spawnedBy: parentKey,
              spawnDepth: 1,
            });
            expect(readEntry(parentKey)).toMatchObject(parentOverride);
            const transcript = await readHistory(client, spawn.childSessionKey);
            expect(assistantTexts(transcript.messages)).toContain(INITIAL_SUCCESS);
          } finally {
            if (grantToken) {
              revokeMcpLoopbackClientGrant(grantToken);
            }
            admission.close();
          }
          expect(provider.errors).toEqual([]);
        },
      ),
    600_000,
  );
});
