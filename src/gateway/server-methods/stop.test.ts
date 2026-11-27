import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  authorizationClient,
  startExactAuthorizationRequest,
} from "../server-methods.authorization.test-support.js";
import { expectRpcError } from "./rpc-response.test-support.js";

const { readActiveGatewayLockIdentity, prepareHostedGatewayStop } = vi.hoisted(() => ({
  readActiveGatewayLockIdentity: vi.fn(),
  prepareHostedGatewayStop: vi.fn(),
}));

vi.mock("../../infra/gateway-lock.js", () => ({ readActiveGatewayLockIdentity }));
vi.mock("../../daemon/hosted-stop.js", () => ({ prepareHostedGatewayStop }));
vi.mock("../../infra/restart-coordinator.js", () => ({
  scheduleSafeGatewayRestart: vi.fn(),
  createSafeGatewayRestartPreflight: vi.fn(),
}));

const target = { pid: process.pid, ownerId: "scheduled-task-owner", port: 18_789 };
const activeLock = { ...target, createdAt: "2026-09-26T12:00:00.000Z" };
const nativeStop = { execute: vi.fn(), dispose: vi.fn() };
const acceptStop = vi.fn();
let host: ReturnType<typeof createGatewayHostLifecycle>;

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
  readActiveGatewayLockIdentity.mockResolvedValue(activeLock);
  prepareHostedGatewayStop.mockResolvedValue(nativeStop);
  host = createGatewayHostLifecycle({
    isCurrent: () => true,
    isServing: () => true,
    acceptStop,
    processOwner: { ownsProcessLifecycle: true, supervisor: "schtasks" },
  });
});

afterEach(async () => {
  await host.retire();
  resetGatewayWorkAdmission();
});

function dispatchStop(
  options: {
    params?: Record<string, unknown>;
    scopes?: string[];
    signal?: AbortSignal;
  } = {},
) {
  const client = authorizationClient(
    crypto.randomUUID(),
    options.scopes ?? ["operator.admin"],
    { clientIp: "127.0.0.1" },
    {
      client: { id: "cli", version: "test", platform: "win32", mode: "cli" },
    },
  );
  const { request, respond } = startExactAuthorizationRequest(
    "gateway.stop.request",
    options.params ?? { target },
    {
      client,
      context: createDirectChatContext({
        getRuntimeConfig: () => ({}),
        hostLifecycle: host.capability,
      }),
      signal: options.signal,
    },
    crypto.randomUUID(),
  );
  return { request, respond };
}

it("dispatches an authenticated targeted stop to the existing host lifecycle", async () => {
  const { request, respond } = dispatchStop();
  await request;

  expect(acceptStop).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(true, {
    ok: true,
    pid: process.pid,
    status: "scheduled",
  });
});

it("rejects non-admin callers before reading host identity", async () => {
  const { request, respond } = dispatchStop({ scopes: ["operator.write"] });
  await request;
  expect(acceptStop).not.toHaveBeenCalled();
  expectRpcError(respond, { message: expect.stringContaining("operator.admin") });
  expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
});

it.each([
  ["missing target", {}],
  ["different PID", { target: { ...target, pid: process.pid + 1 } }],
  ["different owner", { target: { ...target, ownerId: "replacement-owner" } }],
  ["different port", { target: { ...target, port: target.port + 1 } }],
])("rejects %s without stopping the host", async (_label, params) => {
  const { request, respond } = dispatchStop({ params });
  await request;
  expect(acceptStop).not.toHaveBeenCalled();
  expectRpcError(respond, { code: "INVALID_REQUEST" });
});

it("rejects an aborted request during stop preparation", async () => {
  const reached = createDeferred();
  const released = createDeferred();
  readActiveGatewayLockIdentity.mockImplementationOnce(async () => {
    reached.resolve();
    await released.promise;
    return activeLock;
  });
  const abort = new AbortController();
  const { request, respond } = dispatchStop({ signal: abort.signal });
  await reached.promise;
  abort.abort(new Error("stop request cancelled"));
  released.resolve();
  await request;
  expect(prepareHostedGatewayStop).not.toHaveBeenCalled();
  expect(acceptStop).not.toHaveBeenCalled();
  expectRpcError(respond, { code: "UNAVAILABLE" });
});
