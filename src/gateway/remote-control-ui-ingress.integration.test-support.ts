import { expect } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { SessionsFilesPreviewResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
export const TRUSTED_PROXY = {
  userHeader: "cf-access-authenticated-user-email",
  requiredHeaders: ["cf-access-jwt-assertion"],
};
export const TEAM_ROLES: NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]> = {
  default: "reader",
  definitions: {
    admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
    reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
    policy: {
      scopes: ["operator.admin"],
      agents: "*",
      sessions: { others: "write" },
      accessPolicyPlugin: "unavailable-policy-fixture",
    },
  },
};

export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO4E2DzHwAF3AJov2Ds8QAAAABJRU5ErkJggg==",
  "base64",
);

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
    status?: SessionsFilesPreviewResult["status"];
    sandboxPath?: SessionsFilesPreviewResult["sandboxPath"];
    nonce?: string;
    controlUiUrl?: string;
    auth?: { method: string; role: string; scopes: string[]; deviceToken?: string };
    pending?: unknown[];
    paired?: Array<{
      deviceId: string;
      scopes: string[];
      approvedVia: string;
    }>;
  };
  error?: { code: string; message: string };
};

export type Peer = {
  send(frame: unknown): Promise<void>;
  read(): Promise<IngressFrame>;
  close(): Promise<void>;
};

type ConnectOptions = {
  identity?: DeviceIdentity;
  auth?: { token?: string; password?: string; deviceToken?: string; bootstrapToken?: string };
  role?: string;
  scopes?: string[];
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
  let device: ConnectParams["device"];
  if (identity) {
    const payload = buildDeviceAuthPayloadV3({
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
    });
    device = {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(
        identity.privateKeyPem,
        options.tamperSignature ? `${payload}-tampered` : payload,
      ),
      signedAt,
      nonce,
    };
  }
  const hello = await request(peer, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role,
    scopes: options.scopes,
    auth: options.auth,
    ...(device ? { device } : {}),
  });
  if (hello.ok && !options.owner) {
    expect(hello).toHaveProperty(
      "payload.snapshot.presence",
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: client.instanceId,
          user: expect.objectContaining({ id: options.profileId ?? "gateway-owner" }),
        }),
      ]),
    );
  }
  return hello;
}

export function expectHello(frame: IngressFrame, method: string, scopes: readonly string[]): void {
  expect(frame).toMatchObject({
    ok: true,
    payload: { type: "hello-ok", auth: { method, role: "operator", scopes } },
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
  const triggers = [trigger];
  for (const method of ["voicewake.set", "voicewake.get"]) {
    expect(
      await request(peer, method, method === "voicewake.set" ? { triggers } : {}),
    ).toMatchObject({ ok: true, payload: { triggers } });
  }
  expect(await request(peer, "config.set", { raw: "{}" })).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
}

/** An enrolled signed source must keep its person and device ceiling, even under owner transport. */
export async function expectEnrolledOperatorIngress(
  openOwner: () => Promise<{ peer: Peer; close: () => Promise<void> }>,
) {
  const person = await ensureCanonicalUserProfileForEmail("enrolled-ingress@example.test");
  const identity = loadOrCreateDeviceIdentity({ identityKey: "personal-ingress" });
  const pending = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    role: "operator",
    scopes: ["operator.read"],
    clientId: "openclaw-control-ui",
    clientMode: "webchat",
    platform: "browser",
  });
  await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
    operatorProfileId: person.id,
  });
  const owner = await openOwner();
  try {
    await usePeer(owner.peer, async (peer) => {
      expectHello(
        await connect(peer, { identity, profileId: person.id, scopes: ["operator.admin"] }),
        "remote-ingress",
        ["operator.read"],
      );
      expect(await request(peer, "users.self", {})).toMatchObject({
        ok: true,
        payload: { profile: { id: person.id } },
      });
      expect(
        (await request(peer, "users.setRole", { profileId: person.id, role: "admin" })).ok,
      ).toBe(false);
    });
  } finally {
    await owner.close();
  }
}
