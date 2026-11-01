import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import { gatewayTestTextTransport } from "../connection-transport.test-support.js";
import { createGatewaySnapshotFixture } from "../health-state.test-support.js";
import { createAdmissionHandler } from "./message-handler.admission.test-support.js";

const { loadConfigMock, upsertPresenceMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ gateway: { auth: { mode: "none" } } })),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));
vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));
vi.mock("../../../infra/system-presence.js", () => ({
  commitPresence: vi.fn(),
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));
vi.mock("../health-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../health-state.js")>()),
  buildGatewaySnapshot: vi.fn(() => createGatewaySnapshotFixture()),
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
}));
vi.mock("../../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
}));

import { attachGatewayWsMessageHandler } from "./message-handler.js";

const cleanups: Array<() => Promise<void>> = [];

function attachHarness(params: { deferSocketSend?: boolean; startupPending?: boolean } = {}) {
  const connectionWork = new GatewayConnectionWork();
  let onMessage: ((data: WebSocket.RawData) => void) | undefined;
  let finishSocketSend: (() => void) | undefined;
  let closed = false;
  const socketSend = vi.fn((_payload: string, callback?: (error?: Error) => void) => {
    if (params.deferSocketSend && !closed) {
      finishSocketSend = () => callback?.();
      return;
    }
    callback?.();
  });
  const socket = {
    _receiver: { _maxPayload: MAX_PREAUTH_PAYLOAD_BYTES, _allowSynchronousEvents: false },
    send: socketSend,
    on: vi.fn((event: string, handler: (data: WebSocket.RawData) => void) => {
      if (event === "message") {
        onMessage = handler;
      }
      return socket;
    }),
  } as unknown as WebSocket;
  const close = vi.fn(() => {
    closed = true;
    finishSocketSend?.();
  });
  cleanups.push(async () => {
    close();
    connectionWork.beginClose();
    await connectionWork.drain();
  });
  const handler = createAdmissionHandler({
    socket: gatewayTestTextTransport(socket),
    connectionWork,
    upgradeReq: {
      headers: { host: "127.0.0.1:19001" },
      socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage,
    connectNonce: "suspension-connect-nonce",
    getResolvedAuth: () => ({ mode: "none", allowTailscale: false }),
    isStartupPending: () => params.startupPending === true,
    // Backend admission cases never publish presence; hello is mocked above.
    buildRequestContext: () => ({}) as GatewayRequestContext,
    refreshHealthSnapshot: vi.fn(async () => ({}) as never),
    close,
    isClosed: () => closed,
  });
  attachGatewayWsMessageHandler(handler);
  if (!onMessage) {
    throw new Error("expected websocket message handler");
  }
  const sendConnect = (id: string, connect: unknown) =>
    onMessage?.(
      Buffer.from(JSON.stringify({ type: "req", id, method: "connect", params: connect })),
    );
  const connectParams = {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
    role: "operator",
    scopes: [],
    caps: [],
  };

  return {
    close,
    finishSocketSend: () => finishSocketSend?.(),
    get client() {
      return handler.getClient();
    },
    sendConnect: (scopes: unknown = []) => sendConnect("connect-1", { ...connectParams, scopes }),
    sendWorkerConnect: () => sendConnect("worker-connect", { role: "worker" }),
    sendStartupNodeConnect: () =>
      sendConnect("startup-node-connect", {
        ...connectParams,
        client: { id: "node-host", version: "dev", platform: "linux", mode: "node" },
        role: "node",
        commands: [],
        auth: { bootstrapToken: "startup-bootstrap-token" },
        device: {
          id: "startup-node-device",
          publicKey: "startup-node-public-key",
          signature: "startup-node-signature",
          signedAt: Date.now(),
          nonce: "suspension-connect-nonce",
        },
      }),
    send: handler.send,
    setCloseCause: handler.setCloseCause,
    setClient: handler.setClient,
    socketSend,
  };
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  resetGatewayWorkAdmission();
});

describe("WebSocket connect suspension admission", () => {
  it.each(["operator.admin", "xoperator.adminx"])(
    "rejects non-array scopes %s before admitting the client",
    async (scopes) => {
      const harness = attachHarness();
      harness.sendConnect(scopes);

      await vi.waitFor(() => expect(harness.close).toHaveBeenCalled());
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "connect-1",
          ok: false,
          error: expect.objectContaining({ code: "INVALID_REQUEST" }),
        }),
      );
      expect(harness.client).toBeNull();
      expect(harness.setClient).not.toHaveBeenCalled();
    },
  );

  it("rejects a validated connect while suspension is preparing before session mutations", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    const harness = attachHarness();

    harness.sendConnect();

    await vi.waitFor(() => expect(harness.socketSend).toHaveBeenCalledOnce());
    const response = JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}") as {
      error?: {
        code?: string;
        retryable?: boolean;
        retryAfterMs?: number;
        details?: Record<string, unknown>;
      };
    };
    expect(response.error).toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1_000,
      details: {
        method: "connect",
        reason: "gateway-suspending",
        phase: "preparing",
      },
    });
    expect(harness.client).toBeNull();
    expect(harness.setClient).not.toHaveBeenCalled();
    expect(upsertPresenceMock).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway suspension in progress"),
    );
    suspension?.rollback();
  });

  it.each(["draining", "prepared"] as const)(
    "accepts an authenticated operator reconnect while suspension is %s",
    async (phase) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(phase === "draining" ? suspension?.drain() : suspension?.commit()).toBe(true);
      const harness = attachHarness();

      harness.sendConnect();

      await vi.waitFor(() => expect(harness.setClient).toHaveBeenCalledOnce());
      expect(harness.client).not.toBeNull();
      expect(harness.close).not.toHaveBeenCalled();
      const response = JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}");
      expect(response.payload.snapshot.suspension).toEqual({ phase });
      suspension?.release();
    },
  );

  it.each(["restart", "suspension"] as const)(
    "keeps %s closed to an exact startup node shape",
    async (operation) => {
      const suspension =
        operation === "suspension" ? tryBeginGatewaySuspendAdmission(() => {}) : null;
      if (suspension) {
        expect(suspension.commit()).toBe(true);
      } else {
        markGatewayRestartDraining();
      }
      const harness = attachHarness({ startupPending: operation === "suspension" });
      harness.sendStartupNodeConnect();
      await vi.waitFor(() => expect(harness.socketSend).toHaveBeenCalledOnce());
      expect(
        JSON.parse(harness.socketSend.mock.calls[0]?.[0] ?? "{}").error?.details,
      ).toMatchObject({
        method: "connect",
        reason: operation === "restart" ? "gateway-restarting" : "gateway-suspending",
      });
      expect(harness.setClient).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(harness.close).toHaveBeenCalledWith(1013, `gateway ${operation} in progress`),
      );
      suspension?.release();
    },
  );

  it("keeps an accepted handshake visible as root work until hello is sent", async () => {
    const harness = attachHarness({ deferSocketSend: true });

    harness.sendConnect();

    await vi.waitFor(() => expect(harness.socketSend).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(suspension?.rollback()).toBe(true);

    harness.finishSocketSend();
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("rejects worker identity on the general gateway ingress", async () => {
    const harness = attachHarness();
    harness.sendWorkerConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"));
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.setCloseCause).toHaveBeenCalledWith("invalid-handshake", {
      handshakeError: "invalid worker handshake",
    });
  });
});
