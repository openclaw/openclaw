import { withTimeout } from "../utils/with-timeout.js";
import { createSlackWebClient } from "./client.js";
export async function probeSlack(token, timeoutMs = 2500) {
    const client = createSlackWebClient(token);
    const start = Date.now();
    try {
        const result = await withTimeout(client.auth.test(), timeoutMs);
        if (!result.ok) {
            return {
                ok: false,
                status: 200,
                error: result.error ?? "unknown",
                elapsedMs: Date.now() - start,
            };
        }
        return {
            ok: true,
            status: 200,
            elapsedMs: Date.now() - start,
            bot: { id: result.user_id ?? undefined, name: result.user ?? undefined },
            team: { id: result.team_id ?? undefined, name: result.team ?? undefined },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = typeof err.status === "number"
            ? err.status
            : null;
        return {
            ok: false,
            status,
            error: message,
            elapsedMs: Date.now() - start,
        };
    }
}
