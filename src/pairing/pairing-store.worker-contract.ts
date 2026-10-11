import type { PairingRequestRecord } from "./pairing-store.types.js";

export type PairingSelector = { code: string } | { requestId: string; channel: string };
type PairingResolution = { id: string; entry: PairingRequestRecord } | null;
export type PairingMutation =
  | { action: "allow"; accountId: string; entry: string; remove: boolean }
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
      | { action: "list"; requests: PairingRequestRecord[] }
      | { action: "upsert"; code: string; created: boolean }
      | { action: "resolve"; result: PairingResolution };
  };
};
