import type { ClientCredentialDatabase } from "./client-credential-schema.js";

export type ClientNativeTokenSelector =
  | { kind: "all" }
  | { kind: "role"; role: string }
  | { kind: "gateway"; gateway: string }
  | { kind: "unscoped" };

export type ClientIdentityRecord = ClientCredentialDatabase["device_identities"];
export type ClientTokenRecord = ClientCredentialDatabase["device_auth_tokens"];
export type ClientSocketRecord = ClientCredentialDatabase["native_exec_socket_credentials"];
export type ClientTokenKey = Pick<ClientTokenRecord, "device_id" | "role"> & {
  gateway_scope?: string;
};

/** Typed owner operations; IPC decoding belongs at its local transport boundary. */
export type ClientCredentialOperation =
  | { kind: "identity.read"; identity_key: string }
  | { kind: "identity.create"; identity: ClientIdentityRecord }
  | { kind: "identity.repair"; identity: ClientIdentityRecord }
  | {
      kind: "token.list";
      device_id: string;
      gateway_scope?: string;
      afterRole?: string;
      limit?: number;
    }
  | { kind: "native.tokens.clear"; device_id: string; selector: ClientNativeTokenSelector }
  | { kind: "native.token.claim"; device_id: string; role: string; gateway: string }
  | { kind: "token.read"; key: ClientTokenKey }
  | {
      kind: "token.replace";
      key: ClientTokenKey;
      token: ClientTokenRecord;
      expectedToken?: string | null;
    }
  | {
      kind: "token.remove";
      key: ClientTokenKey;
      expectedToken?: string | null;
      observedToken?: string;
    }
  | { kind: "socket.read" }
  | {
      kind: "socket.ensure";
      fallback: ClientSocketRecord;
      requested?: { path?: string; token?: string };
    };

export type ClientCredentialResult =
  | { kind: "identity"; identity: ClientIdentityRecord | null }
  | { kind: "token"; token: ClientTokenRecord | null }
  | { kind: "tokens"; tokens: ClientTokenRecord[]; nextRole: string | null }
  | { kind: "identityRepair"; identity: ClientIdentityRecord; repaired: boolean; rotated: boolean }
  | { kind: "changed"; changed: boolean }
  | { kind: "cleared"; count: number }
  | { kind: "socket"; socket: ClientSocketRecord | null };
