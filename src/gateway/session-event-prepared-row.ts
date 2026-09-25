import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export async function withPreparedSessionEventRow(
  projection: SessionRowProjection | undefined,
  sessionKey: string,
  eventAgentId: string | undefined,
  publish: () => void,
) {
  if (!projection) {
    publish();
    return;
  }
  const routingAgentId = resolveSessionEventAgentScope(
    getRuntimeConfig(),
    sessionKey,
    eventAgentId,
  )?.[1];
  if (routingAgentId) {
    await withReadySessionRows(
      projection,
      () => [{ key: sessionKey, agentId: routingAgentId }],
      () => publish(),
      { includeAncestors: true },
    );
    return;
  }
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
  publish();
}
