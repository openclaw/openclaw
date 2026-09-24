import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type TestContext } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  createPreparedTestApprovalManager,
  createTestApprovalFixture,
} from "../exec-approval-manager.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import {
  waitForApprovalAccepted,
  waitForApprovalRequested,
} from "./approval-request.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

const execApprovalNoop = () => false;
type ExecApprovalHandlers = ReturnType<typeof createExecApprovalHandlers>;
type ExecApprovalGetArgs = Parameters<ExecApprovalHandlers["exec.approval.get"]>[0];
export type ExecApprovalRequestArgs = Parameters<ExecApprovalHandlers["exec.approval.request"]>[0];
export type ExecApprovalResolveArgs = Parameters<ExecApprovalHandlers["exec.approval.resolve"]>[0];
type ExecApprovalWaitArgs = Parameters<ExecApprovalHandlers["exec.approval.waitDecision"]>[0];

export const defaultExecApprovalRequestParams = {
  command: "echo ok",
  commandArgv: ["echo", "ok"],
  systemRunPlan: {
    argv: ["/usr/bin/echo", "ok"],
    cwd: "/tmp",
    commandText: "/usr/bin/echo ok",
    agentId: "main",
    sessionKey: "agent:main:main",
  },
  cwd: "/tmp",
  nodeId: "node-1",
  host: "node",
  timeoutMs: 2000,
} as const;

export function createExecApprovalClient(params: {
  connId: string;
  clientId: string;
  deviceId?: string;
  scopes?: string[];
  approvalRuntime?: boolean;
  agentRuntimeIdentity?: AgentRuntimeIdentity;
}): ExecApprovalRequestArgs["client"] {
  const internal = {
    ...(params.approvalRuntime ? { approvalRuntime: true } : {}),
    ...(params.agentRuntimeIdentity
      ? {
          agentRuntimeIdentity: params.agentRuntimeIdentity,
        }
      : {}),
  };
  return {
    connId: params.connId,
    connect: {
      client: { id: params.clientId },
      device: params.deviceId ? { id: params.deviceId } : undefined,
      scopes: params.scopes,
    },
    ...(Object.keys(internal).length > 0 ? { internal } : {}),
  } as unknown as ExecApprovalRequestArgs["client"];
}

export function createApprovalRuntimeClient(
  connId: string,
  deviceId?: string,
  agentRuntimeIdentity?: { agentId: string; sessionKey: string },
) {
  const runtime = agentRuntimeIdentity
    ? { ...agentRuntimeIdentity, operationalRunInstance: createOperationalRunInstanceRef(connId) }
    : undefined;
  const delegated = runtime
    ? claimAgentRunDelegatedAuthority(runtime.operationalRunInstance)
    : undefined;
  const client = createExecApprovalClient({
    connId,
    clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    deviceId,
    scopes: ["operator.approvals"],
    approvalRuntime: true,
    agentRuntimeIdentity:
      runtime && delegated
        ? { kind: "agentRuntime", ...runtime, delegatedAuthority: { kind: "local", ...delegated } }
        : undefined,
  });
  return {
    ...expectDefined(client, "approval runtime client"),
    [Symbol.dispose]() {
      if (delegated) {
        releaseAgentRunDelegatedAuthority(delegated);
      }
    },
  };
}

function toExecApprovalRequestContext(context: {
  broadcast: (event: string, payload: unknown) => void;
  hasExecApprovalClients?: () => boolean;
  chatAbortedRuns?: Map<string, number>;
}): ExecApprovalRequestArgs["context"] {
  return {
    getRuntimeConfig: () => ({}),
    ...context,
  } as unknown as ExecApprovalRequestArgs["context"];
}

function toExecApprovalResolveContext(
  context: { broadcast?: (event: string, payload: unknown) => void } = {},
): ExecApprovalResolveArgs["context"] {
  return {
    getRuntimeConfig: () => ({}),
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    ...context,
  } as unknown as ExecApprovalResolveArgs["context"];
}

export async function getExecApproval(params: {
  handlers: ExecApprovalHandlers;
  id: string;
  respond: ReturnType<typeof vi.fn>;
  client?: ExecApprovalGetArgs["client"];
}) {
  return expectDefined(
    params.handlers["exec.approval.get"],
    'params.handlers["exec.approval.get"] test invariant',
  )({
    params: { id: params.id } as ExecApprovalGetArgs["params"],
    respond: params.respond as unknown as ExecApprovalGetArgs["respond"],
    context: toExecApprovalResolveContext(),
    client: params.client ?? null,
    req: { id: "req-get", type: "req", method: "exec.approval.get" },
    isWebchatConnect: execApprovalNoop,
  });
}

export async function listExecApprovals(params: {
  handlers: ExecApprovalHandlers;
  respond: ReturnType<typeof vi.fn>;
  client?: ExecApprovalResolveArgs["client"];
}) {
  return expectDefined(
    params.handlers["exec.approval.list"],
    'params.handlers["exec.approval.list"] test invariant',
  )({
    params: {} as never,
    respond: params.respond as never,
    context: toExecApprovalResolveContext(),
    client: params.client ?? null,
    req: { id: "req-list", type: "req", method: "exec.approval.list" },
    isWebchatConnect: execApprovalNoop,
  });
}

export async function requestExecApproval(params: {
  handlers: ExecApprovalHandlers;
  respond: ExecApprovalRequestArgs["respond"];
  context: { broadcast: (event: string, payload: unknown) => void };
  params?: Record<string, unknown>;
  client?: ExecApprovalRequestArgs["client"];
}) {
  const requestParams = {
    ...defaultExecApprovalRequestParams,
    ...params.params,
  } as unknown as ExecApprovalRequestArgs["params"];
  const hasExplicitPlan =
    params.params !== undefined && Object.hasOwn(params.params, "systemRunPlan");
  if (
    !hasExplicitPlan &&
    (requestParams as { host?: string }).host === "node" &&
    Array.isArray((requestParams as { commandArgv?: unknown }).commandArgv)
  ) {
    const commandArgv = (requestParams as { commandArgv: unknown[] }).commandArgv.map((entry) =>
      String(entry),
    );
    const cwdValue =
      typeof (requestParams as { cwd?: unknown }).cwd === "string"
        ? ((requestParams as { cwd: string }).cwd ?? null)
        : null;
    const commandText =
      typeof (requestParams as { command?: unknown }).command === "string"
        ? ((requestParams as { command: string }).command ?? null)
        : null;
    requestParams.systemRunPlan = {
      argv: commandArgv,
      cwd: cwdValue,
      commandText: commandText ?? commandArgv.join(" "),
      agentId:
        typeof (requestParams as { agentId?: unknown }).agentId === "string"
          ? ((requestParams as { agentId: string }).agentId ?? null)
          : null,
      sessionKey:
        typeof (requestParams as { sessionKey?: unknown }).sessionKey === "string"
          ? ((requestParams as { sessionKey: string }).sessionKey ?? null)
          : null,
    };
  }
  return expectDefined(
    params.handlers["exec.approval.request"],
    'params.handlers["exec.approval.request"] test invariant',
  )({
    params: requestParams,
    respond: params.respond as unknown as ExecApprovalRequestArgs["respond"],
    context: toExecApprovalRequestContext({
      hasExecApprovalClients: () => true,
      ...params.context,
    }),
    client: params.client ?? null,
    req: { id: "req-1", type: "req", method: "exec.approval.request" },
    isWebchatConnect: execApprovalNoop,
  });
}

export async function resolveExecApproval(params: {
  handlers: ExecApprovalHandlers;
  id: string;
  decision?: "allow-once" | "allow-always" | "deny";
  respond: ReturnType<typeof vi.fn>;
  context: { broadcast: (event: string, payload: unknown) => void };
  client?: ExecApprovalResolveArgs["client"];
}) {
  return expectDefined(
    params.handlers["exec.approval.resolve"],
    'params.handlers["exec.approval.resolve"] test invariant',
  )({
    params: {
      id: params.id,
      decision: params.decision ?? "allow-once",
    } as ExecApprovalResolveArgs["params"],
    respond: params.respond as unknown as ExecApprovalResolveArgs["respond"],
    context: toExecApprovalResolveContext(params.context),
    client: params.client ?? null,
    req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
    isWebchatConnect: execApprovalNoop,
  });
}

export async function resolveExecApprovalForTest(
  params: Omit<Parameters<typeof resolveExecApproval>[0], "respond">,
) {
  const respond = vi.fn();
  await resolveExecApproval({ ...params, respond });
  return respond;
}

export async function waitExecApproval(params: {
  handlers: ExecApprovalHandlers;
  id: string;
  respond: ReturnType<typeof vi.fn>;
  context: object;
}) {
  return expectDefined(
    params.handlers["exec.approval.waitDecision"],
    'params.handlers["exec.approval.waitDecision"] test invariant',
  )({
    params: { id: params.id },
    respond: params.respond as unknown as ExecApprovalWaitArgs["respond"],
    context: params.context as ExecApprovalWaitArgs["context"],
    client: null,
    req: { id: "req-wait", type: "req", method: "exec.approval.waitDecision" },
    isWebchatConnect: execApprovalNoop,
  });
}

export async function createExecApprovalFixture(
  testContext: TestContext,
  opts?: { config?: OpenClawConfig; preparePersistence?: boolean },
) {
  const fixture =
    opts?.preparePersistence === false
      ? createTestApprovalFixture(testContext)
      : await createPreparedTestApprovalManager(testContext);
  const { manager } = fixture;
  const handlers = createExecApprovalHandlers(manager);
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => opts?.config ?? {},
    broadcast: (event: string, payload: unknown) => {
      broadcasts.push({ event, payload });
    },
    hasExecApprovalClients: () => true,
    chatRunState: createChatRunState(),
  };
  return { ...fixture, handlers, broadcasts, respond, context };
}

export async function expectRejectedExecApprovalRequest(
  testContext: TestContext,
  params: Record<string, unknown>,
  message: string,
) {
  const fixture = await createExecApprovalFixture(testContext, { preparePersistence: false });
  return await fixture.run(async () => {
    const { handlers, respond, context } = fixture;
    await requestExecApproval({ handlers, respond, context, params });
    const call = expectDefined(respond.mock.calls[0], "expected rejected exec approval response");
    expect(call[0]).toBe(false);
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBeTypeOf("object");
    expect(call[2]).toMatchObject({ message });
  });
}

export function getRequestedExecApprovalPayload(
  broadcasts: Array<{ event: string; payload: unknown }>,
): { approvalKind: "exec"; id: string; request: Record<string, unknown> } {
  const requested = broadcasts.find((entry) => entry.event === "exec.approval.requested");
  if (!requested) {
    throw new Error("exec approval requested broadcast missing");
  }
  const payload = requested.payload as {
    approvalKind?: unknown;
    id?: unknown;
    request?: Record<string, unknown>;
  };
  if (payload.approvalKind !== "exec") {
    throw new Error("exec approval requested kind missing");
  }
  if (typeof payload.id !== "string" || payload.id.length === 0) {
    throw new Error("exec approval requested id missing");
  }
  return {
    approvalKind: payload.approvalKind,
    id: payload.id,
    request: payload.request ?? {},
  };
}

type RequestedExecApproval = Awaited<ReturnType<typeof createExecApprovalFixture>> &
  ReturnType<typeof getRequestedExecApprovalPayload> & { requestPromise: Promise<void> };

export async function withAcceptedExecApproval(
  testContext: TestContext,
  params: {
    request: Record<string, unknown>;
    client?: ExecApprovalRequestArgs["client"];
  },
  inspect: (approval: RequestedExecApproval) => Promise<void>,
) {
  const fixture = await createExecApprovalFixture(testContext);
  await fixture.run(async () => {
    const { pending: requestPromise } = await waitForApprovalAccepted(fixture.respond, (respond) =>
      fixture.track(
        requestExecApproval({
          handlers: fixture.handlers,
          respond,
          context: fixture.context,
          params: params.request,
          client: params.client,
        }),
      ),
    );
    await inspect({
      ...fixture,
      ...getRequestedExecApprovalPayload(fixture.broadcasts),
      requestPromise,
    });
    await requestPromise;
  });
}

export async function withRequestedExecApproval(
  testContext: TestContext,
  params: {
    request?: Record<string, unknown>;
    client?: ExecApprovalRequestArgs["client"];
    fixtureOptions?: Parameters<typeof createExecApprovalFixture>[1];
  },
  inspect: (approval: RequestedExecApproval) => Promise<void>,
) {
  const fixture = await createExecApprovalFixture(testContext, params.fixtureOptions);
  await fixture.run(async () => {
    const { pending: requestPromise } = await waitForApprovalRequested(
      fixture.context,
      "exec.approval.requested",
      () =>
        fixture.track(
          requestExecApproval({
            handlers: fixture.handlers,
            respond: fixture.respond,
            context: fixture.context,
            params: params.request,
            client: params.client,
          }),
        ),
    );
    await inspect({
      ...fixture,
      ...getRequestedExecApprovalPayload(fixture.broadcasts),
      requestPromise,
    });
    await requestPromise;
  });
}

export async function requestExecApprovalForTest(
  testContext: TestContext,
  request: Record<string, unknown>,
  fixtureOptions?: Parameters<typeof createExecApprovalFixture>[1],
) {
  const fixture = await createExecApprovalFixture(testContext, fixtureOptions);
  return await fixture.run(async () => {
    await requestExecApproval({
      handlers: fixture.handlers,
      respond: fixture.respond,
      context: fixture.context,
      params: request,
    });
    return { ...fixture, ...getRequestedExecApprovalPayload(fixture.broadcasts) };
  });
}

export async function createForwardingExecApprovalFixture(
  testContext: TestContext,
  opts?: {
    webPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
    iosPushDelivery?: {
      handleRequested: ReturnType<typeof vi.fn>;
      handleResolved: ReturnType<typeof vi.fn>;
      handleExpired: ReturnType<typeof vi.fn>;
    };
  },
) {
  const fixture = await createPreparedTestApprovalManager(testContext);
  const { manager } = fixture;
  const forwarder = {
    handleRequested: vi.fn(async () => false),
    handleResolved: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const handlers = createExecApprovalHandlers(manager, {
    forwarder,
    iosPushDelivery: opts?.iosPushDelivery as never,
  });
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => ({}),
    broadcast: (_eventValue: string, _payload: unknown) => {},
    hasExecApprovalClients: () => false,
    approvalWebPushDelivery: opts?.webPushDelivery,
  };
  return {
    ...fixture,
    handlers,
    forwarder,
    webPushDelivery: opts?.webPushDelivery,
    iosPushDelivery: opts?.iosPushDelivery,
    respond,
    context,
  };
}

export function createIosPushDelivery(
  handleRequested: ReturnType<typeof vi.fn> = vi.fn(async () => true),
) {
  return {
    handleRequested,
    handleResolved: vi.fn(async () => {}),
    handleExpired: vi.fn(async () => {}),
  };
}

export function createWebPushDelivery(
  handleRequested: ReturnType<typeof vi.fn> = vi.fn(async () => true),
) {
  return {
    handleRequested,
    handleResolved: vi.fn(async () => {}),
    handleExpired: vi.fn(async () => {}),
  };
}
