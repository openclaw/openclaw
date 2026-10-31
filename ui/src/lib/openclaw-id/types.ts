// Response shapes of the OpenClaw ID Gateway methods (openclawId.*) the Control UI reads.
import type { SignedStatement } from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { OpenClawIdLinkPreparation } from "./link.ts";

export type OpenClawIdPublication =
  | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
  | { state: "needs_enrollment_code" }
  | { state: "failed"; code: string; message: string };

/** The parts of `openclawId.status` the account menu needs. */
export type OpenClawIdStatusResult = {
  status: {
    state: "off" | "unconfigured" | "on" | "failed";
    /** The tunnel child while on; `relayOnline` once its outbound relay connection is up. */
    tunnel?: { state: string; relayOnline?: boolean };
  };
  /** The same public summary for every client; owner data is in `openclawId.people`. */
  link: {
    linked: boolean;
    clawId?: string;
    hostname?: string;
    rootPub?: string;
    rootEpoch?: number;
    /** Conflicting owner-key changes arrived; owner-key regeneration on loopback resolves it. */
    frozen?: boolean;
  };
  /** How this browser reaches the Gateway: only `local_operator` may link or sign in. */
  channel: "local_operator" | "tunnel" | null;
  /** Whether `openclawId.people` answers this client (loopback operator or an owner device). */
  owner?: boolean;
  services: {
    issuerUrl: string | null;
    discoveryUrl: string | null;
    loaderDomain: string | null;
    /** The Control UI's sign-in client; absent means sign-in is not configured. */
    clientId?: string | null;
  };
};

/** Owner-only link state (`openclawId.people` result `link`). */
export type OpenClawIdPeopleLink = OpenClawIdStatusResult["link"] & {
  seq?: number;
  /** Active owner devices only; revoked and expired ones are not listed. */
  ownerDevices?: OpenClawIdOwnerDevice[];
};

/** An active owner device as `openclawId.people` lists it. */
export type OpenClawIdOwnerDevice = {
  devicePub: string;
  label: string;
  peerKeys: string[];
  /** Its OwnerDeviceCert: public and signed, needed as the chain of its own changes. */
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
