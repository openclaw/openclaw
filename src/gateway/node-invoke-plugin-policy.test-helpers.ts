import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type TestContext } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { createTestApprovalFixture } from "./exec-approval-manager.test-support.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";
import {
  createApprovalClient,
  createApprovalClientLookup,
  waitForApprovalRequested,
} from "./server-methods/approval-request.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

export const DEMO_PLUGIN_ID = "demo";
export const DEMO_COMMAND = "demo.read";
export const DEMO_PARAMS = { path: "/tmp/x" };

export const createNodeSession = (overrides: Partial<NodeSession> = {}): NodeSession => ({
  nodeId: "node-1",
  connId: "conn-1",
  client: {} as NodeSession["client"],
  declaredCaps: [],
  caps: [],
  declaredCommands: ["demo.read"],
  commands: ["demo.read"],
  declaredNodePluginTools: [],
  nodePluginTools: [],
  nodeSkills: [],
  connectedAtMs: 0,
  ...overrides,
});

export const nodeCommandsConfig = (commands: { allow?: string[]; deny?: string[] }) => ({
  gateway: { nodes: { commands } },
});

type ContextOptions = Partial<
  Pick<
    GatewayRequestContext,
    | "pluginApprovalManager"
    | "getApprovalClientConnIds"
    | "getRuntimeConfig"
    | "hasExecApprovalClients"
    | "forwardPluginApprovalRequest"
    | "pluginApprovalIosPushDelivery"
    | "validateAgentRuntimeApprovalAuthority"
  >
> & { nodeSession?: NodeSession };

export function createContext({
  nodeSession = createNodeSession(),
  getRuntimeConfig = () => nodeCommandsConfig({ allow: [DEMO_COMMAND] }),
  ...options
}: ContextOptions = {}) {
  const invoke = vi.fn<NodeRegistry["invoke"]>(async (params) => {
    params.onDispatchReady?.("invoke-1");
    return { ok: true, payload: { ok: true, value: 1 }, payloadJSON: null, error: null };
  });
  return {
    context: {
      trackExecution: trackAsyncWork,
      getRuntimeConfig,
      nodeRegistry: {
        get: () => nodeSession,
        getForPairingGeneration: () => nodeSession,
        invoke,
      },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      ...options,
    } as unknown as GatewayRequestContext,
    invoke,
  };
}

export const createOperatorClient = (connId = "conn-requester"): GatewayClient =>
  createApprovalClient({ connId, clientId: "client-owner", deviceId: "device-owner" });

export function createRuntimeClient(
  runId: string,
  sessionKey = "agent:main:test",
  authority = { lifecycleGeneration: "generation", claimId: "claim" },
): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  return {
    ...createOperatorClient(),
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          ...authority,
        },
      },
    },
  };
}

export function createPolicyApprovalFixture(
  test: TestContext,
  options: Omit<
    NonNullable<Parameters<typeof createTestApprovalFixture<PluginApprovalRequestPayload>>[1]>,
    "approvalKind"
  > = {},
  contextOptions: ContextOptions = {},
) {
  const fixture = createTestApprovalFixture<PluginApprovalRequestPayload>(test, {
    approvalKind: "plugin",
    ...options,
  });
  const { context, invoke } = createContext({
    pluginApprovalManager: fixture.manager,
    getApprovalClientConnIds: createApprovalClientLookup([
      createOperatorClient("conn-owner-approval"),
    ]),
    ...contextOptions,
  });
  return {
    ...fixture,
    context,
    invoke,
    request: (
      client: GatewayClient | null = createOperatorClient(),
      overrides: Partial<Parameters<typeof applyPluginNodeInvokePolicy>[0]> = {},
    ) =>
      expectSinglePendingApproval(fixture.manager, context, () =>
        fixture.track(invokeDemoPolicy(context, client, overrides)),
      ),
  };
}

export type NodeInvokePolicyRegistration = PluginRegistry["nodeInvokePolicies"][number];
type NodeInvokePolicyHandler = NodeInvokePolicyRegistration["policy"]["handle"];
export type PluginApprovalRecord = Awaited<
  ReturnType<ExecApprovalManager<PluginApprovalRequestPayload>["listPendingRecords"]>
>[number];

export const createDemoPolicy = (
  handle: NodeInvokePolicyHandler,
): NodeInvokePolicyRegistration => ({
  pluginId: DEMO_PLUGIN_ID,
  policy: { commands: [DEMO_COMMAND], handle },
  pluginConfig: { enabled: true },
  source: "test",
});

export const createApprovalRequestPolicy = (params?: {
  timeoutMs?: number;
  title?: string;
  description?: string;
  toolName?: string;
  agentId?: string;
  allowedDecisions?: readonly ("allow-once" | "allow-always" | "deny")[];
}): NodeInvokePolicyRegistration =>
  createDemoPolicy(async (ctx: OpenClawPluginNodeInvokePolicyContext) => {
    const approval = await ctx.approvals?.request({
      ...params,
      title: params?.title ?? "Sensitive action",
      description: params?.description ?? "Needs approval",
    });
    return { ok: true, payload: approval ?? null };
  });

export function setDangerousDemoCommandRegistry(policies: NodeInvokePolicyRegistration[] = []) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: DEMO_PLUGIN_ID,
      source: "test",
      origin: "bundled",
      enabled: true,
      configSchema: true,
    }),
  );
  registry.nodeHostCommands.push({
    pluginId: DEMO_PLUGIN_ID,
    command: { command: DEMO_COMMAND, dangerous: true, handle: async () => "{}" },
    source: "test",
  });
  registry.nodeInvokePolicies.push(...policies);
  setActivePluginRegistry(registry);
}

export const invokeDemoPolicy = async (
  context: GatewayRequestContext,
  client: GatewayClient | null = null,
  overrides: Partial<Parameters<typeof applyPluginNodeInvokePolicy>[0]> = {},
) =>
  await applyPluginNodeInvokePolicy({
    context,
    client,
    nodeSession: createNodeSession(),
    command: DEMO_COMMAND,
    params: DEMO_PARAMS,
    ...overrides,
  });

export async function expectSinglePendingApproval<T>(
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  context: GatewayRequestContext,
  start: () => Promise<T>,
) {
  const { pending, payload } = await waitForApprovalRequested(
    context,
    "plugin.approval.requested",
    start,
  );
  const records = await manager.listPendingRecords();
  expect(records).toHaveLength(1);
  const record = expectDefined(records[0], "pending approval");
  expect(payload).toMatchObject({ id: record.id });
  return { record, pending };
}

export async function expectApprovalResolution(
  resultPromise: ReturnType<typeof applyPluginNodeInvokePolicy>,
  manager: ExecApprovalManager<PluginApprovalRequestPayload>,
  record: PluginApprovalRecord,
) {
  expect(await manager.resolve(record.id, "allow-once")).toBe(true);
  await expect(resultPromise).resolves.toStrictEqual({
    ok: true,
    payload: { id: record.id, decision: "allow-once" },
  });
  expect((await manager.getSnapshot(record.id))?.consumedDecision).toBe("allow-once");
  expect(await manager.consumeAllowOnce(record.id)).toBe(false);
}
