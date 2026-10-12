import { expect } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import type {
  GatewayControlUiIngressV2,
  GatewayIngressPrincipalBindingV1,
} from "../plugins/gateway-ingress.types.js";

const CLIENT = {
  id: "openclaw-control-ui",
  version: "dev",
  platform: "browser",
  mode: "webchat",
} as const;
let connectionSequence = 0;

export type IngressFrame = {
  type: string;
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: {
    nonce?: string;
    type?: string;
    controlUiUrl?: string;
    sandboxUrl?: string;
    sandboxOrigin?: string;
    auth?: { method: string; role: string; scopes: string[]; deviceToken?: string };
    pending?: unknown[];
    paired?: Array<{
      deviceId: string;
      scopes: string[];
      approvedVia: string;
      tokens: Array<{ role: string; scopes: string[]; revokedAtMs?: number }>;
    }>;
    triggers?: string[];
  };
  error?: { code: string; message: string };
};

export type Peer = {
  send(frame: unknown): Promise<void>;
  read(): Promise<IngressFrame>;
  close(): Promise<void>;
};

export type ConnectOptions = {
  identity?: DeviceIdentity;
  auth?: { token?: string; password?: string; deviceToken?: string; bootstrapToken?: string };
  scopes?: string[];
  role?: string;
  owner?: boolean;
  profileId?: string;
  tamperSignature?: boolean;
};

export async function request(peer: Peer, method: string, params: unknown): Promise<IngressFrame> {
  await peer.send({ type: "req", id: method, method, params });
  for (;;) {
    const frame = await peer.read();
    if (frame.type === "res" && frame.id === method) {
      return frame;
    }
  }
}

export async function connect(peer: Peer, options: ConnectOptions): Promise<IngressFrame> {
  const challenge = await peer.read();
  expect(challenge.event).toBe("connect.challenge");
  const nonce = challenge.payload?.nonce;
  if (!nonce) {
    throw new Error("Missing device challenge nonce");
  }
  const client = {
    ...(options.owner ? { ...CLIENT, id: "cli", mode: "cli" } : CLIENT),
    instanceId: `ingress-browser-${++connectionSequence}`,
  };
  const role = options.role ?? "operator";
  const signedAt = Date.now();
  const identity = options.identity;
  const payload = identity
    ? buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        role,
        scopes: options.scopes ?? [],
        signedAtMs: signedAt,
        token:
          options.auth?.deviceToken ?? options.auth?.bootstrapToken ?? options.auth?.token ?? null,
        nonce,
      })
    : undefined;
  const hello = await request(peer, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role,
    scopes: options.scopes,
    auth: options.auth,
    ...(identity && payload
      ? {
          device: {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(
              identity.privateKeyPem,
              options.tamperSignature ? `${payload}-tampered` : payload,
            ),
            signedAt,
            nonce,
          },
        }
      : {}),
  });
  if (hello.ok && !options.owner) {
    expect(hello).toMatchObject({
      payload: {
        snapshot: {
          presence: expect.arrayContaining([
            expect.objectContaining({
              instanceId: client.instanceId,
              user: expect.objectContaining({ id: options.profileId ?? "gateway-owner" }),
            }),
          ]),
        },
      },
    });
  }
  return hello;
}

export function expectHello(frame: IngressFrame, method: string, scopes: readonly string[]): void {
  expect(frame).toMatchObject({
    ok: true,
    payload: {
      type: "hello-ok",
      auth: { method, role: "operator", scopes },
    },
  });
  expect(frame.payload?.auth).not.toHaveProperty("deviceToken");
  expect(frame.payload?.auth).not.toHaveProperty("bootstrapToken");
}

export async function usePeer<T>(peer: Peer, run: (peer: Peer) => Promise<T>): Promise<T> {
  try {
    return await run(peer);
  } finally {
    await peer.close();
  }
}

export async function expectReadWriteWithoutAdmin(peer: Peer, trigger: string) {
  expect(await request(peer, "voicewake.set", { triggers: [trigger] })).toMatchObject({
    ok: true,
    payload: { triggers: [trigger] },
  });
  expect(await request(peer, "voicewake.get", {})).toMatchObject({
    ok: true,
    payload: { triggers: [trigger] },
  });
  expect(await request(peer, "config.set", { raw: "{}" })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
}

export async function expectOwnerReadAccess(peer: Peer, sessionKey: string) {
  expect(await request(peer, "users.self", {})).toMatchObject({
    ok: true,
    payload: { profile: { id: "gateway-owner" } },
  });
  const listed = await request(peer, "sessions.list", {
    ownerId: "gateway-owner",
    source: "sidebar",
    rowMode: "compact",
    limit: 20,
  });
  expect(listed.error).toBeUndefined();
  expect(listed).toMatchObject({
    ok: true,
    payload: {
      sessions: expect.arrayContaining([
        expect.objectContaining({ key: sessionKey, displayName: "Owner ingress chat" }),
      ]),
    },
  });
}

export async function expectIngressDenials(peer: Peer) {
  // Owner attribution never grants the question/approval/pairing scope families.
  expect(await request(peer, "question.list", {})).toMatchObject({
    ok: false,
    error: {
      code: "FORBIDDEN",
      message: "Session-scoped access requires a verified user profile.",
    },
  });
  for (const [method, scope] of [
    ["exec.approval.list", "operator.approvals"],
    ["device.pair.list", "operator.pairing"],
  ]) {
    expect(await request(peer, method!, {})).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: `missing scope: ${scope}` },
    });
  }
}

export async function expectUiCloseJoinsRpc(
  ui: GatewayControlUiIngressV2,
  binding: GatewayIngressPrincipalBindingV1,
  pending: Promise<unknown>,
  release: () => void,
) {
  const rejected = pending.catch((error: unknown) => error);
  let closed = false;
  const closing = ui.close().then(() => {
    closed = true;
  });
  expect(await rejected).toBeInstanceOf(Error);
  // The grant can serve another real request while the UI waits for its cancelled handler.
  expect(await binding.request("voicewake.get", {})).toHaveProperty("triggers");
  expect(closed).toBe(false);
  release();
  await closing;
  expect(closed).toBe(true);
}
