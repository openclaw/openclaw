import { resolveEmbeddedRunSessionLanePolicy } from "../../agents/embedded-agent-runner/run/lane-runtime.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { retainQueuedAgentRunContext } from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  createKeyedFifoLeaseRegistry,
  type KeyedFifoLease,
} from "../../shared/keyed-fifo-lease.js";

const acceptedExecutions = createKeyedFifoLeaseRegistry(
  Symbol.for("openclaw.acceptedAgentSessionExecutions"),
);

/** Reserve before acknowledging a new turn, not after asynchronous command preparation. */
export function reserveAgentSessionExecution(
  storePath: string,
  sessionKey: string,
  inputProvenance?: InputProvenance,
): KeyedFifoLease {
  const key = JSON.stringify([storePath, sessionKey]);
  const all = acceptedExecutions.reserve([key])!;
  // Agent commands use trigger=user. Preserve the runtime policy that inter-session
  // work yields to humans: foreground waits only for earlier foreground commands,
  // while followups wait for every predecessor (including the spawning BASE).
  // Actual execution still acquires the shared runtime session lane; this is not
  // permission to overlap an active background turn or bypass its cancellation.
  const foreground =
    resolveEmbeddedRunSessionLanePolicy("user", inputProvenance).priority === "foreground"
      ? acceptedExecutions.reserve([JSON.stringify([storePath, sessionKey, "foreground"])])
      : undefined;
  return {
    wait: (signal) => (foreground ?? all).wait(signal),
    release() {
      foreground?.release();
      all.release();
    },
  };
}

/** Keep the accepted run live while its already-bound task waits for command startup. */
export async function waitForAgentSessionExecution(
  executionOrder: KeyedFifoLease,
  params: {
    runId: string;
    ingressOpts: { lifecycleGeneration?: string };
    abortController: AbortController;
  },
): Promise<void> {
  const { lifecycleGeneration } = params.ingressOpts;
  const { signal } = params.abortController;
  const releaseQueuedContext = lifecycleGeneration
    ? retainQueuedAgentRunContext(params.runId, lifecycleGeneration)
    : undefined;
  let admitted = false;
  try {
    if (!(await executionOrder.wait(signal))) {
      throw createAbortError("Agent execution cancelled before session admission");
    }
    signal.throwIfAborted();
    admitted = true;
  } finally {
    releaseQueuedContext?.(admitted ? "admitted" : "abandoned");
  }
}
