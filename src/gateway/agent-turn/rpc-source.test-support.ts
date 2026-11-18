import { afterEach } from "vitest";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import {
  requestRpcSourceCancellation,
  type RpcSourceAdapter,
  type RpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";

export { setRpcSourceIdentityForTest as setTestRpcSourceIdentity } from "../../sessions/session-lifecycle-admission.test-support.js";

const sources = new Set<RpcSourceRef>();
let storeSequence = 0;
afterEach(() => {
  for (const source of sources) {
    retireSessionControllerInput(source.input);
  }
  sources.clear();
});

export function createTestRpcSource(
  metadata: RpcSourceAdapter & RpcSourceIdentity,
  runId = "test-run",
  storeScope?: string,
): RpcSourceRef {
  const { sessionKey, sessionId, agentId, ...adapter } = metadata;
  const input = reserveSessionControllerSource(sessionKey, {
    protocolRunId: runId,
    sourceTurnId: runId,
    target: captureSessionTarget({
      storeScope: storeScope ?? `/synthetic/agent-rpc/${++storeSequence}/sessions.db`,
      sessionKey,
      incarnation: sessionId,
      agentId,
    }),
    policy: { mode: "followup" },
    adapter,
  });
  const source = { input, adapter };
  sources.add(source);
  return source;
}

export function testRpcSourceController(source: RpcSourceRef): AbortController {
  return {
    signal: source.input.abortSignal,
    abort: (reason?: unknown) => {
      requestRpcSourceCancellation(source, reason);
    },
  };
}
