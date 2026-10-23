import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { HostDesktopCredentialsRequiredError } from "../desktop/host-source-errors.js";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "../desktop/node-source-context.js";
import * as observeBridge from "../desktop/observe-bridge.js";
import {
  resolveDesktopObserveRequester,
  type DesktopObserveRequester,
} from "../desktop/observe-requester.js";
import type { GatewayClient } from "./client-types.js";
import { invokeEnvironment as invoke } from "./environments.test-support.js";

const hostRequest = { source: { kind: "host" } } as const;

afterEach(() => vi.restoreAllMocks());

function createRequesterClient(signal: AbortSignal): GatewayClient {
  return {
    connId: "desktop-requester",
    connectionSignal: signal,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: GATEWAY_CLIENT_IDS.CLI, version: "test", platform: "test", mode: "cli" },
    },
  };
}

it("releases only the requesting connection's unclaimed observation once", async () => {
  const controller = new AbortController();
  const client = createRequesterClient(controller.signal);
  let authorityCurrent = true;
  const requester = resolveDesktopObserveRequester({
    client,
    hasCurrentClientAuthority: () => authorityCurrent,
  });
  const onAbandon = vi.fn(async () => {});
  const { token } = observeBridge.mintDesktopObserverToken({
    sourceKey: "desktop-release",
    ownerEpoch: 1,
    control: true,
    attachment: { kind: "tcp", host: "127.0.0.1", port: 5900 },
    requester,
    onAbandon,
  });
  const params = { wsPath: `/desktop/observe?token=${token}` };
  try {
    const other = { ...client, connId: "another-desktop-requester" };
    expect((await invoke("desktop.release", params, {}, other))[1]).toEqual({ released: false });
    authorityCurrent = false;
    expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: false });
    expect(onAbandon).not.toHaveBeenCalled();
    authorityCurrent = true;
    expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: true });
    expect((await invoke("desktop.release", params, {}, client))[1]).toEqual({ released: false });
    expect(onAbandon).toHaveBeenCalledOnce();
  } finally {
    controller.abort();
  }
});

it.each(["host", "node", "environment", "worker alias"] as const)(
  "binds %s observers to live requester authority",
  async (source) => {
    const credentials = { password: "memory-only-node-password" };
    const params =
      source === "host"
        ? { ...hostRequest, control: true }
        : source === "node"
          ? { source: { kind: "node", nodeId: "node-1" }, credentials }
          : source === "environment"
            ? { source: { kind: "environment", environmentId: "worker:one" } }
            : { environmentId: "worker:one", control: true };
    const controller = new AbortController();
    const client = createRequesterClient(controller.signal);
    let authorityCurrent = true;
    const observe = vi.fn(
      async (request: { requester?: DesktopObserveRequester; control: boolean }) => ({
        control: request.control,
      }),
    );
    const [ok, result] = await invoke(
      source === "worker alias" ? "worker.desktop.observe" : "desktop.observe",
      params,
      {
        getRuntimeConfig: () => ({ desktop: { host: { enabled: true } } }),
        hostDesktopService: { observe },
        [NODE_DESKTOP_SERVICE_CONTEXT]: { observe },
        workerEnvironmentService: { observeDesktop: observe },
      },
      client,
      () => authorityCurrent,
    );
    expect(ok).toBe(true);
    expect(result).toMatchObject({ control: source === "worker alias" || source === "host" });
    expect(result).not.toHaveProperty("vncPassword");
    if (source === "node") {
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: "node-1", credentials }),
      );
    }
    const requester = observe.mock.calls[0]?.[0].requester;
    expect(requester).toMatchObject({ connId: client.connId, signal: controller.signal });
    expect(requester?.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(controller.signal.aborted).toBe(false);
    expect(requester?.isCurrent()).toBe(false);
    client.invalidated = false;
    authorityCurrent = false;
    expect(requester?.isCurrent()).toBe(false);
    authorityCurrent = true;
    expect(requester?.isCurrent()).toBe(true);
    controller.abort();
    expect(requester?.isCurrent()).toBe(false);
  },
);

it("reports ARD credentials as required and forwards an in-memory retry", async () => {
  const observe = vi.fn(
    async (params: { credentials?: { username?: string; password?: string } }) => {
      if (!params.credentials) {
        throw new HostDesktopCredentialsRequiredError();
      }
      return { auth: "ard-account" as const };
    },
  );
  const context = {
    getRuntimeConfig: () => ({ desktop: { host: { enabled: true } } }),
    hostDesktopService: { observe },
  };
  const [firstOk, , firstError] = await invoke("desktop.observe", hostRequest, context);
  expect(firstOk).toBe(false);
  expect(firstError).toMatchObject({
    code: ErrorCodes.INVALID_REQUEST,
    details: {
      code: "DESKTOP_CREDENTIALS_REQUIRED",
      auth: "ard-account",
    },
  });

  const credentials = { username: "operator", password: "account-password" };
  const [retryOk, result] = await invoke(
    "desktop.observe",
    { ...hostRequest, credentials },
    context,
  );
  expect(retryOk).toBe(true);
  expect(result).toMatchObject({ auth: "ard-account" });
  expect(result).not.toHaveProperty("vncPassword");
  expect(observe).toHaveBeenLastCalledWith({ control: false, credentials });
});
