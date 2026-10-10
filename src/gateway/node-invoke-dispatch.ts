import { performance } from "node:perf_hooks";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import type { NodeInvokeResult } from "./node-invoke.types.js";
import type { NodeRunnerRegistrySession } from "./node-runner-inventory-runtime.js";

type PairedNode = NodeRunnerRegistrySession & { pairingIdentity: string };

/** Finish caller restriction checks while retaining the registry's exact live connection. */
export async function prepareNodeInvokeDispatch(input: {
  prepare: () => Promise<void>;
  node: PairedNode;
  currentNode: () => PairedNode | undefined;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  expectedPairingGeneration?: string;
}): Promise<
  | {
      ok: true;
      complete: () => { ok: true; node: PairedNode } | { ok: false; result: NodeInvokeResult };
    }
  | { ok: false; result: NodeInvokeResult }
> {
  const connId = input.node.connId;
  const pairingIdentity = input.node.pairingIdentity;
  const prepared = await awaitWithinDeadline(
    () => racePromiseWithAbortSignal(input.prepare(), input.signal),
    input.deadlineAtMs,
    () => performance.now(),
  );
  if (prepared === ABSOLUTE_DEADLINE_EXPIRED) {
    return {
      ok: false,
      result: { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } },
    };
  }
  return {
    ok: true,
    complete: () => {
      const current = input.currentNode();
      if (!current || current.connId !== connId) {
        return {
          ok: false,
          result: {
            ok: false,
            error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
          },
        };
      }
      if (
        current.client.invalidated === true ||
        current.pairingIdentity !== pairingIdentity ||
        (input.expectedPairingGeneration &&
          current.pairingGeneration !== input.expectedPairingGeneration)
      ) {
        return {
          ok: false,
          result: {
            ok: false,
            error: { code: "PAIRING_CHANGED", message: "node pairing changed before dispatch" },
          },
        };
      }
      return { ok: true, node: current };
    },
  };
}
