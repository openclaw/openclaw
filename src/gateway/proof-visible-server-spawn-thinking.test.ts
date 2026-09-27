import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { maybeSpawnVisibleSession } from "../agents/tools/sessions-spawn-visible.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayToken = "pr-135296-live-proof-token";
const parentModel = "openai/gpt-proof";
const childModel = "openai/gpt-proof";
let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let gatewayWs: Awaited<ReturnType<typeof gateway.openWs>>;

beforeAll(async () => {
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  gateway = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "token", token: gatewayToken }, bind: "loopback" },
  });
  gatewayWs = await gateway.openWs();
  await connectOk(gatewayWs, {
    token: gatewayToken,
    scopes: ["operator.admin"],
    deviceIdentityPath: path.join(process.env.OPENCLAW_STATE_DIR!, "pr-135296-proof-device.sqlite"),
    prePairDevice: true,
  });
});

beforeEach(() => {
  agentCommandMock.mockReset();
  agentCommandMock.mockResolvedValue(undefined);
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "gpt-proof", name: "gpt-proof", provider: "openai", input: ["text"], reasoning: true },
  ];
  testState.gatewayAuth = { mode: "token", token: gatewayToken };
  testState.agentConfig = {
    model: { primary: parentModel },
    subagents: { allowAgents: ["worker"], model: childModel, thinking: "high" },
  };
  testState.agentsConfig = {
    list: [
      { id: "main", default: true, subagents: { allowAgents: ["worker"], thinking: "high" } },
      { id: "worker" },
    ],
  };
});

afterAll(async () => {
  if (gateway) {
    await gateway.close();
  }
});

it("reaches Gateway sessions.create and reads the persisted visible thinking level", async () => {
  const createCalls: Array<Record<string, unknown>> = [];
  const callGateway = async <T>(
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number | null },
  ): Promise<T> => {
    if (method === "sessions.create") {
      createCalls.push(structuredClone(params));
    }
    const result = await rpcReq<Record<string, unknown>>(
      gatewayWs,
      method,
      params,
      options?.timeoutMs ?? 30_000,
    );
    if (!result.ok) {
      throw new Error(result.error?.message ?? `Gateway rejected ${method}`);
    }
    return result.payload as T;
  };

  const parent = await callGateway<{ key?: string }>("sessions.create", {
    agentId: "main",
    key: "agent:main:main",
    label: "PR 135296 proof parent",
    model: parentModel,
  });
  const parentKey = parent.key?.trim();
  expect(parentKey).toBe("agent:main:main");

  const config = {
    agents: {
      defaults: {
        model: { primary: parentModel },
        subagents: { allowAgents: ["worker"], model: childModel, thinking: "high" },
      },
      list: [
        { id: "main", default: true, subagents: { allowAgents: ["worker"], thinking: "high" } },
        { id: "worker" },
      ],
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test-key",
          api: "openai-responses",
          models: [
            {
              id: "gpt-proof",
              name: "gpt-proof",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              contextTokens: 96000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
  const inherited = await maybeSpawnVisibleSession({
    raw: { visible: true, group: "proof-inherited", model: childModel },
    task: "Return proof-ok.",
    label: "PR 135296 inherited thinking proof",
    runtime: "subagent",
    requestedAgentId: "worker",
    sandbox: "inherit",
    expectsCompletionMessage: true,
    options: {
      agentSessionKey: parentKey,
      requesterThinkingLevel: "ultra",
      config,
      callGateway,
      registerRun: vi.fn(),
    },
  });
  const explicit = await maybeSpawnVisibleSession({
    raw: { visible: true, group: "proof-explicit", model: childModel, thinking: "HIGH" },
    task: "Return proof-ok.",
    label: "PR 135296 explicit thinking proof",
    runtime: "subagent",
    requestedAgentId: "worker",
    sandbox: "inherit",
    expectsCompletionMessage: true,
    options: {
      agentSessionKey: parentKey,
      requesterThinkingLevel: "ultra",
      config,
      callGateway,
      registerRun: vi.fn(),
    },
  });
  const negativeBefore = createCalls.length;
  const negative = await maybeSpawnVisibleSession({
    raw: { visible: true, group: "proof-negative", thinking: "not-a-thinking-level" },
    task: "negative control",
    label: "PR 135296 invalid thinking proof",
    runtime: "subagent",
    requestedAgentId: "worker",
    sandbox: "inherit",
    expectsCompletionMessage: true,
    options: { agentSessionKey: parentKey, config, callGateway },
  }).then(
    (result) => `returned ${JSON.stringify(result)}`,
    (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n", 1)[0],
  );
  const listed = await callGateway<{ sessions?: Array<Record<string, unknown>> }>(
    "sessions.list",
    {},
  );
  const inheritedSession = listed.sessions?.find(
    (entry) => entry.key === inherited?.childSessionKey,
  );
  const explicitSession = listed.sessions?.find((entry) => entry.key === explicit?.childSessionKey);
  const inheritedCreate = createCalls.find(
    (entry) => entry.label === "PR 135296 inherited thinking proof",
  );
  const explicitCreate = createCalls.find(
    (entry) => entry.label === "PR 135296 explicit thinking proof",
  );
  const proof = {
    entrypoint:
      "maybeSpawnVisibleSession → Gateway RPC sessions.create → Gateway RPC sessions.list",
    headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    parent: { key: parentKey, activeRequesterThinkingLevel: "ultra" },
    configuredSubagentThinking: "high",
    omitted: {
      status: inherited?.status,
      error: inherited?.error,
      sessionsCreateThinkingLevel: inheritedCreate?.thinkingLevel,
      persistedThinkingLevel: inheritedSession?.thinkingLevel,
    },
    explicit: {
      status: explicit?.status,
      error: explicit?.error,
      sessionsCreateThinkingLevel: explicitCreate?.thinkingLevel,
      persistedThinkingLevel: explicitSession?.thinkingLevel,
    },
    negativeControl: {
      error: negative,
      createCallsBefore: negativeBefore,
      createCallsAfter: createCalls.length,
    },
    gateway: "production Gateway server and SQLite state over authenticated loopback WebSocket",
  };
  console.log(JSON.stringify(proof));

  expect(inherited?.status).toBe("accepted");
  expect(inheritedCreate).toBeDefined();
  expect(inheritedCreate).not.toHaveProperty("thinkingLevel");
  expect(explicit?.status).toBe("accepted");
  expect(explicitCreate?.thinkingLevel).toBe("high");
  expect(explicitSession?.thinkingLevel).toBe("high");
  expect(negative).toContain('Invalid thinking level "not-a-thinking-level"');
  expect(createCalls).toHaveLength(3);
});
