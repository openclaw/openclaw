// Unit-suite stand-in for the typed-turn command owner that Gateway Talk consults enter.
// Real dispatch is covered by server.talk-consult-session-runtime.test.ts; here only the
// contract Talk relies on is modelled: admission from the forwarded authority, then the run.
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";

type Admission = { close: () => void };

export function createTalkCommandOwnerStandIn(params: {
  run: (runParams: Record<string, unknown>) => unknown;
  prepareAdmission?: (admission: Record<string, unknown>) => Admission;
}) {
  return async (opts: AgentCommandGatewayIngressOpts) => {
    const admission = params.prepareAdmission?.({
      operationalRunInstance: opts.operationalRunInstance,
      operatorAuthority: opts.operatorAuthority,
      assertSourceCurrent: opts.assertSourceCurrent,
    });
    try {
      opts.abortSignal?.throwIfAborted();
      return await params.run({
        onSessionIdChanged: opts.onSessionIdChanged,
        runId: opts.runId,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        sessionKey: opts.sessionKey,
        prompt: opts.message,
        lane: opts.lane,
        extraSystemPrompt: opts.extraSystemPrompt,
        thinkLevel: opts.thinkingOnce,
        senderIsOwner: opts.senderIsOwner,
        senderId: opts.runContext?.senderId,
        toolsAllow: opts.toolsAllow,
        toolBindings: opts.toolBindings,
        clientCaps: opts.clientCaps,
        approvalReviewerDeviceId: opts.approvalReviewerDeviceId,
        bashElevated: opts.bashElevated,
        messageProvider: opts.messageProvider,
        abortSignal: opts.abortSignal,
        userTurnTranscriptRecorder: opts.userTurnTranscriptRecorder,
        preparedRunAdmission: admission,
      });
    } finally {
      admission?.close();
    }
  };
}
