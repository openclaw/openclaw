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
let prepareGatewayClientDeviceAuth: typeof import("../gateway/client.js").prepareGatewayClientDeviceAuth;
beforeAll(async () => {
  ({ GatewayClient, prepareGatewayClientDeviceAuth } = await import("../gateway/client.js"));
});

class FixtureSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: FixtureSocket[] = [];
  readyState = 0;
  readonly send = vi.fn((data: string) => {
    this.emit("sent", data);
  });
  constructor() {
    super();
    FixtureSocket.instances.push(this);
  }
  open() {
    this.readyState = FixtureSocket.OPEN;
    this.emit("open");
    this.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "synthetic-nonce", ts: 1_800_000_000_000 },
      }),
    );
  }
  async waitForConnectFrame() {
    if (this.send.mock.calls.length === 0) {
      await once(this, "sent");
    }
    return this.connectFrame();
  }
  connectFrame() {
    const sent = this.send.mock.calls[0];
    assert(sent);
    return JSON.parse(sent[0]) as { id: string; params: { auth: { deviceToken?: string } } };
  }
  respond(payload: unknown, error?: unknown) {
    this.emit(
      "message",
      JSON.stringify({ type: "res", id: this.connectFrame().id, ok: !error, payload, error }),
    );
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

it.each(
  [false, true].flatMap((origin) =>
    ["stop", "reconnect"].map((completion) => ({ origin, completion })),
  ),
)(
  "settles real worker token persistence before $completion (origin: $origin)",
  async ({ origin, completion }) => {
    await withOpenClawTestState({ label: "client-device-token-worker" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      const originLookup = { ...lookup, gatewayScope: "wss://synthetic.example/rpc" };
      const load = () =>
        origin ? tokens.loadOriginDeviceToken(originLookup) : tokens.loadDeviceAuthToken(lookup);
      const storeSpy = vi.spyOn(tokens, origin ? "storeOriginDeviceToken" : "storeDeviceAuthToken");
      if (origin) {
        await tokens.storeOriginDeviceToken({ ...originLookup, token: "synthetic-initial" });
      } else {
        await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-initial" });
      }
      storeSpy.mockClear();
      await closeOpenClawStateDatabaseAsync();
      const sql = observeDeviceAuthHostSql(state.statePath("state", "openclaw.sqlite"));
      const onHelloOk = vi.fn();
      const onConnectError = vi.fn();
      const client = new GatewayClient({
        url: "ws://127.0.0.1:18789",
        env: state.env,
        ...(origin ? { deviceAuthScope: originLookup.gatewayScope } : {}),
        deviceIdentity: {
          deviceId: lookup.deviceId,
          privateKeyPem: "synthetic-private",
          publicKeyPem: "synthetic-public",
        },
        hostDeps: {
          signDevicePayload: () => "synthetic-signature",
          publicKeyRawBase64UrlFromPem: () => "synthetic-public",
          beforeConnect: () => {},
          logError: () => {},
          logDebug: () => {},
        },
        onHelloOk,
        onConnectError,
      });
      let release: (() => Promise<void>) | undefined;
      try {
        client.start();
        const socket = FixtureSocket.instances[0];
        assert(socket);
        socket.open();
        await socket.waitForConnectFrame();
        expect(socket.send).toHaveBeenCalledOnce();
        expect(socket.connectFrame().params.auth.deviceToken).toBe("synthetic-initial");
        release = await holdDeviceAuthWriterForTest(state.statePath("state", "openclaw.sqlite"));
        socket.respond({
          type: "hello-ok",
          protocol: 4,
          auth: { deviceToken: "synthetic-issued", role: "operator", scopes: ["operator.read"] },
        });
        await vi.waitFor(() => expect(storeSpy).toHaveBeenCalledOnce());
        expect(onHelloOk).not.toHaveBeenCalled();
        if (completion === "stop") {
          let stopped = false;
          const stopping = client.stopAndWait().then(() => {
            stopped = true;
          });
          await Promise.resolve();
          expect(stopped).toBe(false);
          await release();
          await stopping;
        } else {
          socket.close(1006, "synthetic transport retired");
          await vi.waitFor(() => expect(FixtureSocket.instances).toHaveLength(2), {
            timeout: 3000,
          });
          const replacement = FixtureSocket.instances[1];
          assert(replacement);
          replacement.open();
          expect(replacement.send).not.toHaveBeenCalled();
          await release();
          await replacement.waitForConnectFrame();
          expect(replacement.send).toHaveBeenCalledOnce();
          expect(replacement.connectFrame().params.auth.deviceToken).toBe("synthetic-issued");
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

it("keeps connection token facts fresh after preparation without duplicate reads", async () => {
  await withOpenClawTestState({ label: "client-token-preparation" }, async (state) => {
    const options = {
      url: "ws://127.0.0.1:18789",
      env: state.env,
      deviceIdentity: {
        deviceId: "synthetic-device",
        privateKeyPem: "synthetic-private",
        publicKeyPem: "synthetic-public",
      },
      hostDeps: {
        signDevicePayload: () => "synthetic-signature",
        publicKeyRawBase64UrlFromPem: () => "synthetic-public",
        beforeConnect: () => {},
        logError: () => {},
        logDebug: () => {},
      },
    };
    const load = vi.spyOn(tokens, "loadDeviceAuthToken");
    await prepareGatewayClientDeviceAuth(options);
    expect(load).not.toHaveBeenCalled();
    await tokens.storeDeviceAuthToken({
      env: state.env,
      deviceId: options.deviceIdentity.deviceId,
      role: "operator",
      token: "synthetic-after-preparation",
    });
    const client = new GatewayClient(options);
    try {
      client.start();
      const socket = FixtureSocket.instances[0];
      assert(socket);
      socket.open();
      await socket.waitForConnectFrame();
      expect(socket.connectFrame().params.auth.deviceToken).toBe("synthetic-after-preparation");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      await client.stopAndWait();
    }
  });
});

it.each([
  { name: "identity omitted", deviceIdentity: null },
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
])("does not prepare token storage for $name", async ({ name: _name, ...overrides }) => {
  await withOpenClawTestState({ label: "client-token-skipped-preparation" }, async (state) => {
    // A skipped storage path must not even consult the legacy migration guard.
    await state.writeJson("identity/device-auth.json", { synthetic: true });
    await prepareGatewayClientDeviceAuth({
      url: "ws://127.0.0.1:18789",
      env: state.env,
      deviceIdentity: {
        deviceId: "synthetic-device",
        privateKeyPem: "synthetic-private",
        publicKeyPem: "synthetic-public",
      },
      ...overrides,
    });
    await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it("prepares read-only clients without creating missing state", async () => {
  await withOpenClawTestState({ label: "client-token-readonly-preparation" }, async (state) => {
    await prepareGatewayClientDeviceAuth({
      url: "ws://127.0.0.1:18789",
      env: state.env,
      sharedStateMode: "read-only",
      deviceIdentity: {
        deviceId: "synthetic-device",
        privateKeyPem: "synthetic-private",
        publicKeyPem: "synthetic-public",
      },
    });
    await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
