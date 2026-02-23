import type { BaseProbeResult } from "../channels/plugins/types.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createSlackWebClient } from "./client.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
};

export async function probeSlack(token: string, timeoutMs = 2500): Promise<SlackProbe> {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      typeof (err as { status?: number }).status === "number"
        ? (err as { status?: number }).status
        : null;
    return {
      ok: false,
      status,
      error: message,
      elapsedMs: Date.now() - start,
    };
  }
}
