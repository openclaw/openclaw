import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GatewayClient as GatewayClientInstance } from "../gateway/client.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as tokens from "./device-auth-store.js";
import { observeDeviceAuthHostSql } from "./device-auth-store.sql.test-support.js";
import { holdDeviceAuthWriterForTest } from "./device-auth-store.test-support.js";

let GatewayClient: typeof GatewayClientInstance;
beforeAll(async () => {
  ({ GatewayClient } = await import("../gateway/client.js"));
});

class FixtureSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: FixtureSocket[] = [];
  readyState = 0;
  readonly send = vi.fn((data: string) => void this.emit("sent", data));
  constructor() {
    super();
    FixtureSocket.instances.push(this);
  }
  open() {
    this.readyState = FixtureSocket.OPEN;
    this.emit("open");
    this.message({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-nonce", ts: 1_800_000_000_000 },
    });
  }
  connectFrame() {
    const sent = this.send.mock.calls[0];
    assert(sent);
    return JSON.parse(sent[0]) as { id: string; params: { auth?: { deviceToken?: string } } };
  }
  message(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }
  respond(payload: unknown) {
    this.message({ type: "res", id: this.connectFrame().id, ok: true, payload });
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
  terminate() {
    this.close();
  }
}
vi.mock("../../packages/gateway-client/src/websocket.js", () => ({ WebSocket: FixtureSocket }));
beforeEach(() => {
  FixtureSocket.instances = [];
});
afterEach(() => vi.restoreAllMocks());

const deviceIdentity = {
  deviceId: "synthetic-device",
  privateKeyPem: "synthetic-private",
  publicKeyPem: "synthetic-public",
};
const hostDeps = {
  signDevicePayload: () => "synthetic-signature",
  publicKeyRawBase64UrlFromPem: () => "synthetic-public",
  beforeConnect: () => {},
  logError: () => {},
  logDebug: () => {},
};

function clientOptions(env: NodeJS.ProcessEnv) {
  return { url: "ws://127.0.0.1:18789", env, deviceIdentity, hostDeps };
}
function openSocket(index = 0) {
  const socket = FixtureSocket.instances[index];
  assert(socket);
  socket.open();
  return socket;
}
async function expectTokenFrame(socket: FixtureSocket, token: string) {
  if (socket.send.mock.calls.length === 0) {
    await once(socket, "sent");
  }
  expect(socket.send).toHaveBeenCalledOnce();
  expect(socket.connectFrame()).toMatchObject({ params: { auth: { deviceToken: token } } });
}

it.each([
  { origin: false, completion: "stop" },
  { origin: true, completion: "reconnect" },
])(
  "settles real worker token persistence before $completion (origin: $origin)",
  async ({ origin, completion }) => {
    await withOpenClawTestState({ label: "client-device-token-worker" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      const originLookup = { ...lookup, gatewayScope: "wss://synthetic.example/rpc" };
      const load = () =>
        origin ? tokens.loadOriginDeviceToken(originLookup) : tokens.loadDeviceAuthToken(lookup);
      const storeSpy = vi.spyOn(tokens, origin ? "storeOriginDeviceToken" : "storeDeviceAuthToken");
      const store = origin ? tokens.storeOriginDeviceToken : tokens.storeDeviceAuthToken;
      // An unscoped facade must ignore the reusable lookup's surplus origin.
      await store({ ...originLookup, token: "synthetic-initial" });
      storeSpy.mockClear();
      await closeOpenClawStateDatabaseAsync();
      const sql = observeDeviceAuthHostSql(state.statePath("client", "credentials.sqlite"));
      const onHelloOk = vi.fn();
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        ...clientOptions(state.env),
        ...(origin ? { deviceAuthScope: originLookup.gatewayScope } : {}),
        onHelloOk,
        onConnectError,
      });
      let release: (() => Promise<void>) | undefined;
      try {
        client.start();
        const socket = openSocket();
        await expectTokenFrame(socket, "synthetic-initial");
        release = await holdDeviceAuthWriterForTest(
          state.statePath("client", "credentials.sqlite"),
        );
        socket.respond({
          type: "hello-ok",
          protocol: 4,
          auth: { deviceToken: "synthetic-issued", role: "operator", scopes: ["operator.read"] },
        });
        await vi.waitFor(() => expect(storeSpy).toHaveBeenCalledOnce());
        expect(onHelloOk).not.toHaveBeenCalled();
        if (completion === "stop") {
          const stopped = vi.fn<() => void>();
          const stopping = client.stopAndWait().then(stopped);
          await Promise.resolve();
          expect(stopped).not.toHaveBeenCalled();
          await release();
          await stopping;
        } else {
          socket.close(1006, "synthetic transport retired");
          await vi.waitFor(() => expect(FixtureSocket.instances).toHaveLength(2), {
            timeout: 3000,
          });
          const replacement = openSocket(1);
          expect(replacement.send).not.toHaveBeenCalled();
          await release();
          await expectTokenFrame(replacement, "synthetic-issued");
        }
        expect(onHelloOk).not.toHaveBeenCalled();
        expect(onConnectError).not.toHaveBeenCalled();
        expect(await load()).toMatchObject({
          token: "synthetic-issued",
          scopes: ["operator.read"],
        });
        await client.stopAndWait();
        await closeOpenClawStateDatabaseAsync();
        expect(Object.values(sql.counts().data)).toEqual(Array(7).fill(0));
        expect(Object.values(sql.counts().unknown)).toEqual(Array(7).fill(0));
      } finally {
        await release?.();
        await client.stopAndWait();
        sql.restore();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  },
);

it("loads current token facts when a connection starts without duplicate reads", async () => {
  await withOpenClawTestState({ label: "client-token-connection" }, async (state) => {
    const options = clientOptions(state.env);
    const load = vi.spyOn(tokens, "loadDeviceAuthToken");
    const client = new GatewayClient(options);
    expect(load).not.toHaveBeenCalled();
    await tokens.storeDeviceAuthToken({
      env: state.env,
      deviceId: options.deviceIdentity.deviceId,
      role: "operator",
      token: "synthetic-after-construction",
    });
    try {
      client.start();
      await expectTokenFrame(openSocket(), "synthetic-after-construction");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      await client.stopAndWait();
    }
  });
});

it.each([
  { name: "identity omitted", deviceIdentity: null },
  { name: "read-only missing state", sharedStateMode: "read-only" as const },
  {
    name: "password-only read-only",
    sharedStateMode: "read-only" as const,
    password: "synthetic-password",
  },
  {
    name: "explicit origin read-only",
    sharedStateMode: "read-only" as const,
    deviceAuthScope: "wss://synthetic.example",
    token: "synthetic-token",
  },
  { name: "invalid transport", url: "ws://synthetic.example" },
  { name: "invalid edge transport", edgeAuthHeaders: { "x-synthetic": "synthetic-value" } },
])("does not create token storage for $name", async ({ name, ...overrides }) => {
  await withOpenClawTestState({ label: "client-token-skipped-connection" }, async (state) => {
    if (name !== "read-only missing state") {
      // A skipped storage path must not even consult the legacy migration guard.
      await state.writeJson("identity/device-auth.json", { synthetic: true });
    }
    const onConnectError = vi.fn();
    const client = new GatewayClient({
      ...clientOptions(state.env),
      onConnectError,
      ...overrides,
    });
    try {
      client.start();
      if (name.startsWith("invalid")) {
        await vi.waitFor(() => expect(onConnectError).toHaveBeenCalledOnce());
        expect(FixtureSocket.instances).toHaveLength(0);
      } else {
        const socket = openSocket();
        await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
        expect(onConnectError).not.toHaveBeenCalled();
      }
      await expect(fs.stat(state.statePath("client", "credentials.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await client.stopAndWait();
    }
  });
});
