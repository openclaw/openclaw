import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { requestSessionUsage, type SessionUsageQuery } from "../../lib/sessions/usage.ts";

/** Provider plans load separately: session usage never waits on provider APIs. */
type UsageSnapshotResult = Result<
  Awaited<ReturnType<typeof requestSessionUsage>>,
  { cause: unknown }
>;

export async function requestUsageSnapshot(
  client: GatewayBrowserClient,
  query: SessionUsageQuery,
  signal?: AbortSignal,
): Promise<UsageSnapshotResult> {
  try {
    return ok(await requestSessionUsage(client, query, { projection: "overview", signal }));
  } catch (cause) {
    if (signal?.aborted) {
      throw cause;
    }
    return err({ cause });
  }
}
