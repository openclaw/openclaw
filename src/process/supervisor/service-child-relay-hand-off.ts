import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import type { ServiceChildControlPayload } from "./service-child-protocol.js";
import type { ProcessRelease, ReleasedProcess } from "./types.js";

/**
 * Host side of a hand-off: the owner exits custody without signalling, and its
 * receipt replaces lineage EOF and group extinction that released processes still hold.
 */
export function createServiceChildHandOff(
  child: ChildProcess,
  generation: string,
  sendControlMessage: (payload: ServiceChildControlPayload) => Promise<void>,
  params: {
    lineage: Readable | null;
    useLinuxSubreaper: boolean;
    /** Host output relays; their output ends at hand-off. */
    outputs: Array<{ end: () => void }>;
  },
) {
  let receipt: ProcessRelease | undefined;
  return {
    get receipt() {
      return receipt;
    },
    accept(survivors: ReleasedProcess[], receiptSequence: number) {
      receipt = { status: "released", survivors };
      void sendControlMessage({ type: "closing-ack", closingSequence: receiptSequence }).catch(
        () => {},
      );
      params.lineage?.destroy();
      if (!params.useLinuxSubreaper && child.connected) {
        // The relay otherwise joins group extinction before it exits.
        child.send({ type: "release", generation }, () => {});
      }
      // The owner drains output that released processes still hold; the
      // result already has the root's output, so close this side now.
      for (const output of params.outputs) {
        output.end();
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (params.useLinuxSubreaper && child.connected) {
        child.disconnect();
      }
      // The owner can outlive a one-shot host while it drains a handed-off root.
      child.unref();
    },
    /** Ask a running owner to hand off; undefined means cancellation must stop it instead. */
    async request(active: boolean, settled: Promise<unknown>) {
      if (active) {
        await Promise.race([
          sendControlMessage({ type: "release" }).then(
            () => settled,
            () => undefined,
          ),
          new Promise<void>((resolve) => {
            // A stalled owner falls back to cancellation; never hold the host open.
            setTimeout(resolve, GRACEFUL_CANCEL_TIMEOUT_MS).unref();
          }),
        ]);
      }
      return receipt?.survivors;
    },
  };
}
