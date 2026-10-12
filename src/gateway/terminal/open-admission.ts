import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import type { TerminalOpenOutcome, TerminalOpenRequest } from "./session-manager.types.js";

/** Gateway lifecycle custody includes pending spawns until their backend settles. */
export async function withAgentTerminalOpenAdmission(
  request: TerminalOpenRequest,
  run: (request: TerminalOpenRequest) => Promise<TerminalOpenOutcome>,
): Promise<TerminalOpenOutcome> {
  const interrupted = new AbortController();
  const signal = request.signal
    ? AbortSignal.any([request.signal, interrupted.signal])
    : interrupted.signal;
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>>;
  try {
    admission = await beginSessionWorkAdmission({
      agentId: request.agentId,
      scope: `agent:${request.agentId}`,
      identities:
        request.owner.kind === "agent"
          ? [request.owner.agentSessionKey, request.owner.agentSessionId]
          : [request.owner.connId],
      signal,
      assertAllowed: () => signal.throwIfAborted(),
      onInterrupt: (reason) => interrupted.abort(reason),
    });
  } catch (error) {
    return {
      ok: false,
      code: "closed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return await admission.run(() => run({ ...request, signal }));
  } finally {
    admission.release();
  }
}
