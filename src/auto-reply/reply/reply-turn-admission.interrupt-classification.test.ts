// Interrupt classification decides whether an admission interruption is recorded
// as a gateway restart. Only a restart-classified interruption leaves the durable
// row `running` + `abortedLastRun`, the pair main-session restart recovery admits
// on, so an ordinary interruption recorded as one dispatches a bogus recovery.
import { describe, expect, it } from "vitest";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../../agents/run-termination.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../../gateway/session-lifecycle-state.js";
import { GatewayDrainingError } from "../../process/gateway-work-admission.js";
import { startSessionWorkAdmissionInterruption } from "../../sessions/session-lifecycle-admission.js";
import {
  admitTestReplyOperation,
  createSessionStoreFor,
} from "./reply-turn-admission.test-support.js";

describe("reply turn admission interrupt classification", () => {
  it.each([
    {
      name: "direct abort",
      reason: () => createAgentRunDirectAbortError(),
      expectedCode: "aborted_by_user",
      restartDisposition: false,
    },
    {
      // A message that arrives while a turn is running takes the `run-now` queue
      // action, which interrupts session work with no reason at all
      // (get-reply-run-admission.ts). An untyped interruption is not a restart.
      name: "untyped lifecycle interruption",
      reason: () => undefined,
      expectedCode: "aborted_by_user",
      restartDisposition: false,
    },
    {
      name: "explicit restart abort",
      reason: () => createAgentRunRestartAbortError(),
      expectedCode: "aborted_for_restart",
      restartDisposition: true,
    },
    {
      name: "gateway drain",
      reason: () => new GatewayDrainingError("gateway is draining for restart"),
      expectedCode: "aborted_for_restart",
      restartDisposition: true,
    },
  ])(
    "records a $name interruption with its own disposition",
    async ({ name, reason, expectedCode, restartDisposition }) => {
      // An interruption recorded as a restart leaves the durable row
      // running + abortedLastRun, which is the exact signature the main-session
      // restart recovery admission looks for. That made every later turn on the
      // session dispatch a bogus "interrupted by gateway restart" recovery.
      const slug = name.replaceAll(" ", "-");
      const sessionKey = `agent:main:interrupt-${slug}`;
      const sessionId = `session-${slug}`;
      const storePath = createSessionStoreFor(sessionKey, sessionId);
      const operation = await admitTestReplyOperation({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
      });
      const interruptReason = reason();
      const interruption = startSessionWorkAdmissionInterruption({
        scope: storePath,
        identities: [sessionKey, sessionId],
        ...(interruptReason ? { reason: interruptReason } : {}),
      });
      try {
        expect(operation.abortSignal.aborted).toBe(true);
        expect(operation.result).toMatchObject({ kind: "aborted", code: expectedCode });
        expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(restartDisposition);
        // The disposition is what the durable row inherits. Only stopReason
        // "restart" keeps status "running" and sets abortedLastRun, which is the
        // pair main-session restart recovery admits on. "aborted" ends the row
        // as "killed", which no recovery path can select.
        const lifecycle = resolveAgentRunAbortLifecycleFields(operation.abortSignal);
        expect(lifecycle.stopReason).toBe(restartDisposition ? "restart" : "aborted");
        expect(
          deriveGatewaySessionLifecycleSnapshot({
            session: { status: "running", startedAt: 1_000, updatedAt: 1_000 },
            event: {
              ts: 2_000,
              sessionId,
              data: { phase: "end", endedAt: 1_800, ...lifecycle },
            },
          }),
        ).toMatchObject(
          restartDisposition
            ? { status: "running", abortedLastRun: true }
            : { status: "killed", abortedLastRun: true },
        );
      } finally {
        operation.complete();
        await interruption.released;
      }
    },
  );
});
