import { logVerbose } from "../../globals.js";
export async function resolvePreparedReplyQueueState(params) {
    if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) {
        return { kind: "continue", busyState: params.resolveBusyState() };
    }
    if (params.queueMode === "interrupt") {
        const aborted = params.abortActiveRun(params.activeSessionId);
        logVerbose(`Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`);
    }
    await params.waitForActiveRunEnd(params.activeSessionId);
    await params.refreshPreparedState();
    const refreshedBusyState = params.resolveBusyState();
    if (refreshedBusyState.isActive) {
        return {
            kind: "reply",
            reply: {
                text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
            },
        };
    }
    return { kind: "continue", busyState: refreshedBusyState };
}
