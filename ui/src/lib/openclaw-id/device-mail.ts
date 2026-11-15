// The browser owns D and all request signatures; the Gateway only relays exact wire bytes.
import {
  bytesToBase64url,
  deviceMailRoute,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  peerKeyProofInput,
  signDiscoveryRequest,
  type DeviceMailOperation,
  type SignedStatement,
  type StatementSigner,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { openClawIdAccount } from "./account.ts";
import { loadMailboxPeerSigner, loadOwnerDeviceSigner } from "./device-key.ts";
import type { OpenClawIdPeopleLink } from "./types.ts";

/** Public owner context used to sign the next membership change and sealed handoff. */
export type OwnerApprovalContext = {
  link: OpenClawIdPeopleLink;
  binding: SignedStatement<"ServerBinding">;
};

/** Reads authoritative owner context through the owner-only boundary. */
export function readOwnerApprovalContext(client: GatewayBrowserClient) {
  return client.request<OwnerApprovalContext>("openclawId.authority", {
    action: "device_mail",
    operation: "context",
  });
}

/** Binds the original browser D for device mail without enrolling its transport-only W. */
export async function createDeviceMail(client: GatewayBrowserClient, signal: AbortSignal) {
  const context = await readOwnerApprovalContext(client);
  const clawId = context.link.clawId;
  const signer = clawId ? await loadOwnerDeviceSigner(clawId) : undefined;
  const pub = signer ? formatEd25519PublicKey(signer.publicKey) : null;
  const own = context.link.ownerDevices?.find((device) => device.devicePub === pub);
  if (!clawId || !signer || !own?.cert.body.caps.includes("approve_device")) {
    throw new Error("This browser does not hold an active owner device key.");
  }
  const mail = signedDeviceMail(client, clawId, signer, own.cert, signal);
  const account = openClawIdAccount();
  if (!account) {
    throw new Error("Sign in with OpenClaw ID to approve another device.");
  }
  const peer = await loadMailboxPeerSigner(clawId);
  const ts = Math.floor(Date.now() / 1000);
  const parts = {
    account_id: account.sub,
    device_pub: own.cert.body.device_pub,
    peer_key: formatIrohEndpointKey(peer.publicKey),
    ts,
  };
  const proof = bytesToBase64url(await peer.sign(peerKeyProofInput(parts)));
  await mail.call("bind", {
    ...parts,
    account_id: undefined,
    label: own.label,
    peer_key_proof: proof,
  });
  return { ...mail, signer, own: own.cert, context, clawId };
}

// Signs with D, keeping account credentials and exact body bytes out of Gateway persistence.
function signedDeviceMail(
  client: GatewayBrowserClient,
  clawId: string,
  signer: StatementSigner,
  certificate: SignedStatement<"OwnerDeviceCert">,
  signal: AbortSignal,
) {
  return {
    async call<T>(operation: DeviceMailOperation, payload?: unknown, after = "0"): Promise<T> {
      signal.throwIfAborted();
      const account = openClawIdAccount();
      if (!account) {
        throw new Error("OpenClaw ID sign-in expired. Sign in again to continue.");
      }
      const route = deviceMailRoute(operation, clawId, after);
      const body = payload === undefined ? "" : JSON.stringify(payload);
      const signature = await signDiscoveryRequest(
        { ...route, body: new TextEncoder().encode(body), ts: Math.floor(Date.now() / 1000) },
        signer,
      );
      signal.throwIfAborted();
      const response = await client.request<{ status: number; body: string }>(
        "openclawId.authority",
        {
          action: "device_mail",
          operation,
          body,
          after,
          signature,
          idToken: account.idToken,
          certificate,
        },
        { timeoutMs: 30_000, signal },
      );
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Owner-device mail failed (HTTP ${response.status}).`);
      }
      // SAFETY: T is the Discovery mailbox response shape for this operation.
      return (response.body ? JSON.parse(response.body) : undefined) as T;
    },
  };
}

export type DeviceMail = Awaited<ReturnType<typeof createDeviceMail>>;
