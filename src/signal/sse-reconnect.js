import { logVerbose, shouldLogVerbose } from "../globals.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { streamSignalEvents } from "./client.js";
const DEFAULT_RECONNECT_POLICY = {
    initialMs: 1000,
    maxMs: 10000,
    factor: 2,
    jitter: 0.2,
};
export async function runSignalSseLoop({ baseUrl, account, abortSignal, runtime, onEvent, policy, }) {
    const reconnectPolicy = {
        ...DEFAULT_RECONNECT_POLICY,
        ...policy,
    };
    let reconnectAttempts = 0;
    const logReconnectVerbose = (message) => {
        if (!shouldLogVerbose()) {
            return;
        }
        logVerbose(message);
    };
    while (!abortSignal?.aborted) {
        try {
            await streamSignalEvents({
                baseUrl,
                account,
                abortSignal,
                onEvent: (event) => {
                    reconnectAttempts = 0;
                    onEvent(event);
                },
            });
            if (abortSignal?.aborted) {
                return;
            }
            reconnectAttempts += 1;
            const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
            logReconnectVerbose(`Signal SSE stream ended, reconnecting in ${delayMs / 1000}s...`);
            await sleepWithAbort(delayMs, abortSignal);
        }
        catch (err) {
            if (abortSignal?.aborted) {
                return;
            }
            runtime.error?.(`Signal SSE stream error: ${String(err)}`);
            reconnectAttempts += 1;
            const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
            runtime.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
            try {
                await sleepWithAbort(delayMs, abortSignal);
            }
            catch (sleepErr) {
                if (abortSignal?.aborted) {
                    return;
                }
                throw sleepErr;
            }
        }
    }
}
