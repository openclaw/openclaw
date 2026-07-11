import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  WorkerAdmissionResponseFrameSchema,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerAdmissionFailureReason,
  type WorkerConnectParams,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { WorkerConnectionIdentity } from "../../worker-environments/connection-identity.js";
import type { GatewayWsClient } from "../ws-types.js";
import { attachWorkerWsMessageHandler, type WorkerConnectionService } from "./worker-connection.js";

const CREDENTIAL = ["worker", "credential", "fixture"].join("-");
const HANDSHAKE = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.11",
  protocolFeatures: ["worker-heartbeat-v1"],
};
const WORKER_CONNECT: WorkerConnectParams = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: GATEWAY_CLIENT_IDS.WORKER,
    version: "2026.7.11",
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.WORKER,
  },
  role: "worker",
  admission: {
    environmentId: "worker-1",
    credential: CREDENTIAL,
    sessionId: null,
    ownerEpoch: 1,
    rpcSetVersion: 1,
    handshake: HANDSHAKE,
  },
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "worker-1",
  credentialHash: "h".repeat(43),
  bundleHash: HANDSHAKE.bundleHash,
  sessionId: null,
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: [...HANDSHAKE.protocolFeatures],
  credentialExpiresAtMs: Date.now() + 60_000,
};
const cleanups: Array<() => void> = [];

function createLogger() {
  return { warn: vi.fn() };
}

function attachHarness(
  options: {
    admissionFailure?: WorkerAdmissionFailureReason;
    identity?: WorkerConnectionIdentity;
    validationFailure?: ReturnType<WorkerConnectionService["validateWorkerConnection"]>;
    validationPasses?: number;
  } = {},
) {
  let onMessage: ((data: RawData) => void) | undefined;
  const socket = {
    on: vi.fn((event: string, handler: (data: RawData) => void) => {
      if (event === "message") {
        onMessage = handler;
      }
      return socket;
    }),
    off: vi.fn((event: string, handler: (data: RawData) => void) => {
      if (event === "message" && onMessage === handler) {
        onMessage = undefined;
      }
      return socket;
    }),
  } as unknown as WebSocket;
  const responses: unknown[] = [];
  const close = vi.fn();
  let validationCalls = 0;
  const service = {
    admitWorker: vi.fn(async () =>
      options.admissionFailure
        ? { ok: false as const, reason: options.admissionFailure }
        : { ok: true as const, identity: options.identity ?? IDENTITY },
    ),
    validateWorkerConnection: vi.fn(() => {
      validationCalls += 1;
      return validationCalls > (options.validationPasses ?? 0)
        ? (options.validationFailure ?? null)
        : null;
    }),
  } as WorkerConnectionService;
  let client: GatewayWsClient | null = null;
  const setClient = vi.fn((next: GatewayWsClient) => {
    client = next;
    return true;
  });
  const logGateway = createLogger();
  const logWsControl = createLogger();
  const cleanup = attachWorkerWsMessageHandler({
    socket,
    connId: "worker-connection",
    service,
    send: (frame) => responses.push(frame),
    close,
    isClosed: () => false,
    clearHandshakeTimer: vi.fn(),
    getClient: () => client,
    setClient,
    setHandshakeState: vi.fn(),
    advanceHandshakePhase: vi.fn(),
    setCloseCause: vi.fn(),
    setLastFrameMeta: vi.fn(),
    logGateway,
    logWsControl,
  });
  cleanups.push(cleanup);
  if (!onMessage) {
    throw new Error("expected worker websocket message handler");
  }
  const sendRaw = (raw: string | Buffer) =>
    onMessage?.(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  return {
    client: () => client,
    close,
    logGateway,
    logWsControl,
    responses,
    service,
    setClient,
    sendRaw,
    sendRequest: (id: string, method: string, params: unknown) =>
      sendRaw(JSON.stringify({ type: "req", id, method, params })),
    sendConnect: (params: unknown = WORKER_CONNECT) =>
      sendRaw(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params })),
  };
}

async function admit(harness: ReturnType<typeof attachHarness>): Promise<void> {
  harness.sendConnect();
  await vi.waitFor(() => expect(harness.responses).toHaveLength(1));
}

describe("dedicated worker websocket protocol", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("admits with a minimal secret-free hello", async () => {
    const harness = attachHarness();
    await admit(harness);

    expect(Value.Check(WorkerAdmissionResponseFrameSchema, harness.responses[0])).toBe(true);
    expect(harness.responses[0]).toMatchObject({
      ok: true,
      payload: {
        type: "worker-hello-ok",
        environmentId: "worker-1",
        sessionId: null,
        ownerEpoch: 1,
        rpcSetVersion: 1,
        policy: { maxPayload: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES },
      },
    });
    expect(JSON.stringify([harness.responses, harness.client()])).not.toContain(CREDENTIAL);
    expect(harness.client()).toMatchObject({
      connectionKind: "worker",
      connect: { role: "worker" },
    });
  });

  it("returns a bounded admission rejection", async () => {
    const reason = "invalid-credential" as const;
    const harness = attachHarness({ admissionFailure: reason });
    harness.sendConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, reason));
    expect(harness.responses[0]).toMatchObject({ ok: false, error: { details: { reason } } });
    expect(JSON.stringify(harness.responses)).not.toContain(CREDENTIAL);
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      `worker admission rejected reason=${reason}`,
    );
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it.each([
    ["node.event", { event: "agent.request", payloadJSON: '{"requestId":"r-1"}' }],
    ["health", {}],
    ["status", {}],
    ["worker.inference", {}],
  ])("rejects legacy method %s", async (method, params) => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("forbidden-1", method, params);

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"));
    expect(harness.responses.at(-1)).toMatchObject({
      ok: false,
      error: { details: { reason: "method-not-allowed" } },
    });
    expect(harness.logGateway.warn).toHaveBeenCalledWith(
      "worker protocol request rejected reason=method-not-allowed",
    );
  });

  it("accepts heartbeat and rejects malformed heartbeat parameters", async () => {
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("heartbeat-1", "worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await vi.waitFor(() => expect(valid.responses).toHaveLength(2));
    expect(Value.Check(WorkerHeartbeatResponseFrameSchema, valid.responses[1])).toBe(true);
    expect(valid.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "ok", ownerEpoch: 1 },
    });

    const invalid = attachHarness();
    await admit(invalid);
    invalid.sendRequest("heartbeat-2", "worker.heartbeat", { status: "ready" });
    await vi.waitFor(() => expect(invalid.close).toHaveBeenCalledWith(1008, "invalid-heartbeat"));
    expect(invalid.responses.at(-1)).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-heartbeat" } },
    });
  });

  it("closes expired, malformed, oversized, and stale connections", async () => {
    const expired = attachHarness({
      identity: { ...IDENTITY, credentialExpiresAtMs: Date.now() + 25 },
    });
    await admit(expired);
    await vi.waitFor(() => expect(expired.close).toHaveBeenCalledWith(1008, "credential-expired"));

    const malformed = attachHarness();
    await admit(malformed);
    malformed.sendRaw("{");
    await vi.waitFor(() => expect(malformed.close).toHaveBeenCalledWith(1008, "invalid-frame"));

    const oversized = attachHarness();
    oversized.sendRaw(Buffer.alloc(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES + 1, 120));
    await vi.waitFor(() => expect(oversized.close).toHaveBeenCalledWith(1009, "invalid-handshake"));

    const stale = attachHarness({
      validationFailure: "credential-replaced",
      validationPasses: 1,
    });
    await admit(stale);
    stale.sendRequest("heartbeat-3", "worker.heartbeat", { sentAtMs: 1, status: "ready" });
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledWith(1008, "credential-replaced"));
  });

  it("rejects non-worker identity before admission", async () => {
    const harness = attachHarness();
    harness.sendConnect({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
      role: "operator",
      scopes: [],
    });

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"));
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
  });

  it("revalidates ownership immediately before admission", async () => {
    const harness = attachHarness({ validationFailure: "credential-replaced" });
    harness.sendConnect();

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"));
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it("bounds frames queued before admission", async () => {
    const harness = attachHarness();
    for (let index = 0; index <= 16; index += 1) {
      harness.sendConnect();
    }

    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"));
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      "worker admission rejected reason=invalid-handshake",
    );
  });
});
