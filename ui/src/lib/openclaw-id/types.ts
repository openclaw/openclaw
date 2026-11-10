// Response shapes of the OpenClaw ID Gateway methods (openclawId.*) the Control UI reads.
import type { SignedStatement } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { OpenClawIdLinkPreparation } from "./link.ts";

export type OpenClawIdPublication =
  | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
  | { state: "needs_enrollment_code" }
  | { state: "failed"; code: string; message: string; retryable?: boolean; retryAt?: number };

/** The parts of `openclawId.status` the account menu needs. */
export type OpenClawIdStatusResult = {
  status: {
    state: "off" | "unconfigured" | "on" | "keys_refused" | "failed";
    /** The tunnel child while on; `relayOnline` once its outbound relay connection is up. */
    tunnel?: { state: string; relayOnline?: boolean };
    /** While `keys_refused`: which bound key no file on this computer holds, and why. */
    key?: "endpoint" | "gateway";
    reason?: "keys_missing" | "key_mismatch";
  };
  /** The same public summary for every client; owner data is in `openclawId.people`. */
  link: {
    linked: boolean;
    clawId?: string;
    hostname?: string;
    rootPub?: string;
  };
  /** How this browser reaches the Gateway: only `local_operator` may link or sign in. */
  channel: "local_operator" | "tunnel" | null;
  /** Whether `openclawId.people` answers this client (loopback operator or an owner device). */
  owner?: boolean;
  /** Active owner devices, returned only to an owner. */
  ownerDeviceCount?: number;
  /** Identity verified by the Gateway for this connection. */
  connection?: OpenClawIdConnection;
  services: {
    issuerUrl: string | null;
    discoveryUrl: string | null;
    loaderDomain: string | null;
    /** The Control UI's sign-in client; absent means sign-in is not configured. */
    clientId?: string | null;
  };
};

/**
 * Who this connection is (`openclawId.status` connection): the direct-loopback
 * operator, over the tunnel an owner device or a member, or none of these.
 */
type OpenClawIdConnection =
  | { kind: "local"; accountEmail?: string | null; accountName?: string | null }
  | { kind: "none" }
  | {
      kind: "owner";
      deviceLabel: string | null;
      ownerAccountId: string | null;
      accountEmail?: string | null;
      accountName?: string | null;
    }
  | {
      kind: "member";
      role: "operator" | "viewer";
      accountId: string;
      email: string | null;
      displayName: string | null;
      invitedBy?: { name: string | null; email: string | null } | null;
    };

/** Owner-only link state (`openclawId.people` result `link`). */
export type OpenClawIdPeopleLink = OpenClawIdStatusResult["link"] & {
  seq?: number;
  /** Active owner devices only; removed and expired ones are not listed. */
  ownerDevices?: OpenClawIdOwnerDevice[];
  /** The last publication to Discovery, while one was attempted. */
  publication?: OpenClawIdPublication;
};

/** An active owner device as `openclawId.people` lists it. */
export type OpenClawIdOwnerDevice = {
  devicePub: string;
  /** Fingerprint of the device key D. */
  deviceFp: string;
  label: string;
  peerKeys: string[];
  /** Who approved it: "root" (the recovery kit) or the approving device's fingerprint. */
  approvedBy: string;
  /** When the claw last admitted it (or added it), unix seconds. */
  lastSeen: number;
  /** Its OwnerDeviceCert: public and signed. */
  cert: SignedStatement<"OwnerDeviceCert">;
};

/** The signed-in OpenClaw ID account the Control UI holds (`openclawId.authority` account_complete). */
export type OpenClawIdSignedIn = {
  sub: string;
  email: string | null;
  name: string | null;
  /** ID token expiry, seconds since the epoch. */
  exp: number;
  idToken: string;
};

export type { OpenClawIdLinkPreparation };
