import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "../../../packages/agent-core/src/internal-hooks.js";

export type DeferredShellOutcome =
  | { kind: "not-dispatched" }
  | { kind: "exited"; exitCode: number };
export type RecordDeferredShellOutcome = (outcome: DeferredShellOutcome) => Promise<void>;
export type ShellCallReceipt = {
  runId: string;
  callId: string;
  key: string;
  recordDeferredOutcome?: RecordDeferredShellOutcome;
};
const receipts = new WeakMap<object, ShellCallReceipt>();
export function bindShellResultObservation<T extends object>(
  result: T,
  receipt: ShellCallReceipt,
): T {
  // Each observation has its own transcript identity, including concurrent or repeated polls.
  // The shared opaque prefix is the only fact the recovery owner needs.
  const observation = {
    runId: receipt.runId,
    callId: receipt.callId,
    key: `${receipt.key}/${randomUUID()}`,
  };
  const token = {};
  receipts.set(token, observation);
  return attachInternalToolResultProvenance(result, token);
}

export function shellCallReceipt(runId: string, callId: string): ShellCallReceipt {
  return {
    runId,
    callId,
    key: `shell-result:${randomUUID()}`,
  };
}

/** Wrappers can carry a child's private provenance; only its own terminal writer may redeem it. */
export function shellCallResultKey(
  result: unknown,
  runId: string | undefined,
  callId: string | undefined,
): string | undefined {
  const provenance = isRecord(result) ? getInternalToolResultProvenance(result) : undefined;
  const receipt = provenance && receipts.get(provenance);
  return receipt && receipt.runId === runId && receipt.callId === callId ? receipt.key : undefined;
}
