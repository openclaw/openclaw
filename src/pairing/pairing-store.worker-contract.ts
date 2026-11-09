import type { PairingRequestRecord } from "./pairing-store.types.js";

export type PairingSelector = { code: string } | { requestId: string; channel: string };
export type PairingAllowRemoval = { accountId: string; entry: string };
type PairingResolution = { id: string; entry: PairingRequestRecord } | null;
export type PairingMutation =
  | { action: "allow"; accountId: string; entry: string; remove: boolean }
  /** Forgets every approved sender of one account, or of the whole channel when accountId is empty. */
  | { action: "allowClear"; accountId: string }
  | { action: "list"; accountId: string }
  | { action: "upsert"; id: string; accountId: string; meta: Record<string, string> }
  | {
      action: "resolve";
      accountId: string;
      selector: PairingSelector;
      approval: "dismiss" | "sender" | "host";
    };

export type ChannelPairingWorkerOperations = {
  "channelPairing.mutate": {
    input: { channel: string; mutation: PairingMutation };
    output:
      | { action: "allow"; changed: boolean; allowFrom: string[] }
      | { action: "allowClear"; removed: PairingAllowRemoval[] }
      | { action: "list"; requests: PairingRequestRecord[] }
      | { action: "upsert"; code: string; created: boolean }
      | { action: "resolve"; result: PairingResolution };
  };
};
