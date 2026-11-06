import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isClawId,
  isEd25519PublicKey,
  isKeyFingerprint,
  parseStatement,
  type BindingEvidence,
  type ClawPin,
} from "../../packages/openclaw-id-protocol/src/index.js";

/** Public enrollment facts only. W's secret is held separately in private node state. */
export type NodeHostOpenClawIdTarget = {
  hostname: string;
  pin: ClawPin & { claw_id: string };
  evidence: BindingEvidence;
  relayUrl: string;
};

export function parseNodeHostOpenClawIdTarget(value: unknown): NodeHostOpenClawIdTarget {
  if (
    !isRecord(value) ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    !isRecord(value.pin) ||
    !isClawId(value.pin.claw_id) ||
    !isKeyFingerprint(value.pin.root_fp) ||
    typeof value.pin.binding_seq !== "number" ||
    !Number.isSafeInteger(value.pin.binding_seq) ||
    value.pin.binding_seq < 1 ||
    !isRecord(value.evidence) ||
    !isEd25519PublicKey(value.evidence.root_pub) ||
    typeof value.relayUrl !== "string"
  ) {
    throw new Error("invalid OpenClaw ID node target");
  }
  const relay = URL.parse(value.relayUrl);
  if (
    !relay ||
    !["https:", "http:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.hash
  ) {
    throw new Error("invalid OpenClaw ID relay URL");
  }
  const binding = parseStatement(value.evidence.binding, "ServerBinding");
  if (!binding.ok) {
    throw new Error("invalid OpenClaw ID ServerBinding");
  }
  return {
    hostname: value.hostname,
    pin: {
      claw_id: value.pin.claw_id,
      root_fp: value.pin.root_fp,
      binding_seq: value.pin.binding_seq,
    },
    evidence: { root_pub: value.evidence.root_pub, binding: binding.statement },
    relayUrl: relay.href,
  };
}
