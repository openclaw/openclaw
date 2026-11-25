import type { ResolvedInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { requireSessionRowProjection } from "./session-row-projection-access.js";

/**
 * Holds the `sessions.get` target identity for in-process plugin reads through later inference.
 * Loaded lazily by the dispatch owner: session-row modules reach the subagent registry,
 * which itself imports in-process dispatch.
 */
export async function prepareInProcessSessionRead(
  resolved: ResolvedInProcessGatewayDispatch,
  key: string,
  assertCurrent: () => void,
) {
  const projection = requireSessionRowProjection(resolved.context);
  const requested = resolveRequestedSessionAgentId(resolved.context.getRuntimeConfig(), key);
  if (!requested.ok) {
    throw new Error(requested.error.message);
  }
  const query = { key, agentId: requested.agentId };
  return await withReadySessionRows(
    projection,
    () => [query],
    (read) => {
      assertCurrent();
      const selected = read.describe(query);
      if (!selected?.entry.sessionId) {
        throw new Error(`Session "${key}" was not found.`);
      }
      const assertReadCurrent = () => {
        assertCurrent();
        if (requireSessionRowProjection(resolved.context) !== projection) {
          throw new Error("Session projection replaced. Start a new request.");
        }
        const current = projection.capture(query);
        const entry =
          current &&
          projection.readCapabilityEntry({
            agentId: current.agentId,
            key: current.key,
            storePath: current.storeTarget.storePath,
          })?.entry;
        if (
          !current ||
          !entry ||
          !projection.isCurrent(selected) ||
          entry.sessionId !== selected.entry.sessionId ||
          current.storeTarget.storePath !== selected.storeTarget.storePath
        ) {
          throw new Error(`Session "${key}" was not found.`);
        }
      };
      assertReadCurrent();
      return assertReadCurrent;
    },
  );
}
