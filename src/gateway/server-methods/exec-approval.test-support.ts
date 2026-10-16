import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type TestContext } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
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
  agentRuntimeIdentity?: { agentId: string; sessionKey: string };
}): ExecApprovalRequestArgs["client"] {
  const internal = {
    ...(params.approvalRuntime ? { approvalRuntime: true } : {}),
    ...(params.agentRuntimeIdentity
      ? {
          agentRuntimeIdentity: { kind: "agentRuntime" as const, ...params.agentRuntimeIdentity },
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
  return createExecApprovalClient({
    connId,
    clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    deviceId,
    scopes: ["operator.approvals"],
    approvalRuntime: true,
    agentRuntimeIdentity,
  });
}

function callApproval(
  method: string,
  options: {
    handlers: ExecApprovalHandlers;
    respond: ExecApprovalRequestArgs["respond"];
    client?: ExecApprovalRequestArgs["client"];
  },
  params: Record<string, unknown>,
  id: string,
  context: object = {},
) {
  return expectDefined(
    options.handlers[method],
    `${method} handler`,
  )({
    req: { id, type: "req", method },
    params,
    respond: options.respond,
    client: options.client ?? null,
    context: (method === "exec.approval.waitDecision"
      ? context
      : { getRuntimeConfig: () => ({}), ...context }) as ExecApprovalRequestArgs["context"],
    isWebchatConnect: execApprovalNoop,
  });
}

export async function getExecApproval(params: {
  handlers: ExecApprovalHandlers;
  id: string;
  respond: ReturnType<typeof vi.fn>;
  client?: ExecApprovalGetArgs["client"];
}) {
  return callApproval("exec.approval.get", params, { id: params.id }, "req-get");
}

export async function listExecApprovals(params: {
  handlers: ExecApprovalHandlers;
  respond: ReturnType<typeof vi.fn>;
  client?: ExecApprovalResolveArgs["client"];
}) {
  return callApproval("exec.approval.list", params, {}, "req-list");
}

export async function requestExecApproval(params: {
  handlers: ExecApprovalHandlers;
  respond: ExecApprovalRequestArgs["respond"];
  context: { broadcast: (event: string, payload: unknown) => void };
  params?: Record<string, unknown>;
  client?: ExecApprovalRequestArgs["client"];
}) {
  const requestParams: ExecApprovalRequestArgs["params"] = {
    ...defaultExecApprovalRequestParams,
    ...params.params,
  };
  const hasExplicitPlan =
    params.params !== undefined && Object.hasOwn(params.params, "systemRunPlan");
  if (
    !hasExplicitPlan &&
    requestParams.host === "node" &&
    Array.isArray(requestParams.commandArgv)
  ) {
    const commandArgv = requestParams.commandArgv.map((entry) => String(entry));
    const cwdValue = typeof requestParams.cwd === "string" ? requestParams.cwd : null;
    const commandText = typeof requestParams.command === "string" ? requestParams.command : null;
    requestParams.systemRunPlan = {
      argv: commandArgv,
      cwd: cwdValue,
      commandText: commandText ?? commandArgv.join(" "),
      agentId: typeof requestParams.agentId === "string" ? requestParams.agentId : null,
      sessionKey: typeof requestParams.sessionKey === "string" ? requestParams.sessionKey : null,
    };
  }
  return callApproval("exec.approval.request", params, requestParams, "req-1", {
    hasExecApprovalClients: () => true,
    ...params.context,
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
  return callApproval(
    "exec.approval.resolve",
    params,
    { id: params.id, decision: params.decision ?? "allow-once" },
    "req-2",
    params.context,
  );
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
  return callApproval(
    "exec.approval.waitDecision",
    params,
    { id: params.id },
    "req-wait",
    params.context,
  );
}

export async function createExecApprovalFixture(
  testContext: TestContext,
  opts?: { config?: OpenClawConfig; preparePersistence?: boolean; scheduler?: GatewayScheduler },
) {
  const managerOptions = { scheduler: opts?.scheduler };
  const fixture =
    opts?.preparePersistence === false
      ? createTestApprovalFixture(testContext, managerOptions)
      : await createPreparedTestApprovalManager(testContext, managerOptions);
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
    expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
      false,
      undefined,
      expect.objectContaining({ message }),
    ]);
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

type ApprovalInput = {
  request?: Record<string, unknown>;
  client?: ExecApprovalRequestArgs["client"];
  fixtureOptions?: Parameters<typeof createExecApprovalFixture>[1];
};

async function withApprovalRequest(
  testContext: TestContext,
  params: ApprovalInput,
  inspect: (approval: RequestedExecApproval) => Promise<void>,
  accepted: boolean,
) {
  const fixture = await createExecApprovalFixture(testContext, params.fixtureOptions);
  await fixture.run(async () => {
    const request = (respond: ExecApprovalRequestArgs["respond"] = fixture.respond) =>
      fixture.track(
        requestExecApproval({
          ...fixture,
          respond,
          params: params.request,
          client: params.client,
        }),
      );
    const { pending: requestPromise } = accepted
      ? await waitForApprovalAccepted(fixture.respond, request)
      : await waitForApprovalRequested(fixture.context, "exec.approval.requested", request);
    await inspect({
      ...fixture,
      ...getRequestedExecApprovalPayload(fixture.broadcasts),
      requestPromise,
    });
    await requestPromise;
  });
}

export async function withAcceptedExecApproval(
  testContext: TestContext,
  params: Pick<ApprovalInput, "client"> & { request: Record<string, unknown> },
  inspect: (approval: RequestedExecApproval) => Promise<void>,
) {
  return withApprovalRequest(testContext, params, inspect, true);
}

export async function withRequestedExecApproval(
  testContext: TestContext,
  params: ApprovalInput,
  inspect: (approval: RequestedExecApproval) => Promise<void>,
) {
  return withApprovalRequest(testContext, params, inspect, false);
}

export async function requestExecApprovalForTest(
  testContext: TestContext,
  request: Record<string, unknown>,
  fixtureOptions?: Parameters<typeof createExecApprovalFixture>[1],
) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const fixture = await createExecApprovalFixture(testContext, { ...fixtureOptions, scheduler });
  try {
    return await fixture.run(async () => {
      const { pending } = await waitForApprovalRequested(
        fixture.context,
        "exec.approval.requested",
        () =>
          fixture.track(
            requestExecApproval({
              handlers: fixture.handlers,
              respond: fixture.respond,
              context: fixture.context,
              params: request,
            }),
          ),
      );
      const payload = getRequestedExecApprovalPayload(fixture.broadcasts);
      const record = expectDefined(
        fixture.manager.getLocalSnapshot(payload.id),
        "registered approval deadline",
      );
      using dateNow = vi.spyOn(Date, "now");
      dateNow.mockImplementation(clock.clock.now);
      await clock.advanceTo(record.expiresAtMs);
      await pending;
      return { ...fixture, ...payload };
    });
  } finally {
    await scheduler.stop();
  }
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
  // Prepare persistence before forwarding tests replace the host's timers.
  const scheduler = createTestGatewayScheduler("fake-timers");
  testContext.onTestFinished(() => scheduler.stop());
  const fixture = await createPreparedTestApprovalManager(testContext, { scheduler });
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

export const createWebPushDelivery = createIosPushDelivery;
