import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGatewayHostLifecycle } from "../../cli/gateway-cli/host-lifecycle.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

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
    hasCurrentClientAuthority?: () => boolean;
  } = {},
) {
  const respond = vi.fn();
  const client: GatewayClient = {
    connId: crypto.randomUUID(),
    clientIp: "127.0.0.1",
    connect: {
      role: "operator",
      scopes: options.scopes ?? ["operator.admin"],
      client: { id: "cli", version: "test", platform: "win32", mode: "cli" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  };
  const request = handleGatewayRequest({
    req: {
      type: "req",
      id: crypto.randomUUID(),
      method: "gateway.stop.request",
      params: options.params ?? { target },
    },
    respond,
    client,
    isWebchatConnect: () => false,
    context: {
      logGateway: { warn: vi.fn() },
      hostLifecycle: host.capability,
    } as unknown as GatewayRequestContext,
    signal: options.signal,
    hasCurrentClientAuthority: options.hasCurrentClientAuthority,
  });
  return { request, respond, client };
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

it("requires administrator scope before inspecting the stop target", async () => {
  const { request, respond } = dispatchStop({ scopes: ["operator.write"] });
  await request;

  expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
  expect(acceptStop).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
  );
});

it.each([
  ["missing target", {}],
  ["different PID", { target: { ...target, pid: process.pid + 1 } }],
  ["different owner", { target: { ...target, ownerId: "replacement-owner" } }],
  ["different port", { target: { ...target, port: target.port + 1 } }],
] as const)("rejects %s without stopping the host", async (_label, params) => {
  const { request, respond } = dispatchStop({ params });
  await request;

  expect(acceptStop).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
});

it.each(["signal", "client invalidation", "transport authority"] as const)(
  "rejects a caller that loses %s while looking up the owner",
  async (loss) => {
    const reached = createDeferred();
    const lock = createDeferred<typeof activeLock>();
    readActiveGatewayLockIdentity.mockImplementationOnce(() => {
      reached.resolve();
      return lock.promise;
    });
    const abort = new AbortController();
    let current = true;
    const { request, respond, client } = dispatchStop({
      signal: abort.signal,
      hasCurrentClientAuthority: () => current,
    });
    await reached.promise;
    if (loss === "signal") {
      abort.abort(new Error("stop request cancelled"));
    } else if (loss === "client invalidation") {
      client.invalidated = true;
    } else {
      current = false;
    }
    lock.resolve(activeLock);
    await request;

    expect(prepareHostedGatewayStop).not.toHaveBeenCalled();
    expect(acceptStop).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  },
);

it("retains caller authority through the host's asynchronous stop preparation", async () => {
  const reached = createDeferred();
  const preparation = createDeferred<typeof nativeStop>();
  prepareHostedGatewayStop.mockImplementationOnce(() => {
    reached.resolve();
    return preparation.promise;
  });
  let current = true;
  const { request, respond } = dispatchStop({ hasCurrentClientAuthority: () => current });
  await reached.promise;
  current = false;
  preparation.resolve(nativeStop);
  await request;

  expect(acceptStop).not.toHaveBeenCalled();
  expect(nativeStop.dispose).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      message: "Gateway requester authority changed",
    }),
  );
});
