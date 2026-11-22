import type { StoredClaw } from "./claw-store.js";

/** Retains a claw's endpoint identity across in-flight or uncertain binding writes. */
export function createEndpointKeyPin() {
  let key: string | undefined;
  let clawId: string | undefined;
  return {
    retain(endpointKey: string, id: string | undefined) {
      key = endpointKey;
      clawId = id;
    },
    read(record: StoredClaw | undefined): string | undefined {
      if (record?.binding) {
        key = record.binding.body.k_srv;
        clawId = record.claw_id;
      } else if (record && clawId && record.claw_id !== clawId) {
        // A confirmed unlink replaces the claw id. A prepared link or uncertain write does not.
        key = undefined;
        clawId = undefined;
      }
      return key;
    },
  };
}
