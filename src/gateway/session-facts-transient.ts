import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../agents/embedded-agent-runner/active-run-projections.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { ResolvedInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.types.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";

const temporalKeys = new WeakMap<object, ReadonlySet<string>>();

export function transientSessionKeys(
  context: ResolvedInProcessGatewayDispatch["context"],
  rows: SessionRowReadView["state"]["rowContext"],
  roster: {
    bySessionId: ReadonlyMap<string, ReadonlySet<string>>;
    targets: { has: (key: string) => boolean };
  },
) {
  const keys = new Set(listActiveEmbeddedRunSessionKeys());
  const ids = new Set(listActiveEmbeddedRunSessionIds());
  for (const run of context.chatAbortControllers.values()) {
    if (run.sessionKey) {
      keys.add(run.sessionKey);
    }
    if (run.sessionId) {
      ids.add(run.sessionId);
    }
  }
  const projected = rows.projectedAgentRuns;
  if (projected) {
    for (const [source, target] of [
      [projected.sessionKeys, keys],
      [projected.sessionIds, ids],
    ] as const) {
      for (const identity of source.keys()) {
        target.add(identity.slice(identity.indexOf("\0") + 1));
      }
    }
    for (const key of projected.ownerlessSessionKeys.keys()) {
      keys.add(key);
    }
    for (const id of projected.ownerlessSessionIds.keys()) {
      ids.add(id);
    }
  }
  const subagents = rows.subagentRuns;
  let temporal = temporalKeys.get(subagents.revision);
  if (!temporal) {
    temporal = new Set(
      [...subagents.runsByChildSessionKey].flatMap(([key, runs]) =>
        runs.some((run) => typeof run.execution.endedAt !== "number") ? [key] : [],
      ),
    );
    temporalKeys.set(subagents.revision, temporal);
  }
  for (const key of temporal) {
    keys.add(key);
  }
  // Raw execution owners can precede their durable registry publication.
  for (const run of subagentRuns.values()) {
    if (typeof run.execution.endedAt !== "number") {
      keys.add(run.childSessionKey);
    }
  }
  for (const id of ids) {
    for (const key of roster.bySessionId.get(id) ?? []) {
      keys.add(key);
    }
  }
  return new Set([...keys].filter((key) => roster.targets.has(key)));
}
