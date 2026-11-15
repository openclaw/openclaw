import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { sessionChangedError } from "./sessions-patch-errors.js";

type Ancestor = NonNullable<SessionsPatchParams["expectedSidebarAncestors"]>[number];
type Read = Awaited<ReturnType<typeof prepareSessionMutationFacts>>;

/** Follow authoritative lineage, never caller-supplied lookup keys, and retain worker-prepared facts. */
export async function prepareSessionPatchSidebarAncestors(params: {
  cfg: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  key: string;
  agentId: string;
  ancestors: readonly Ancestor[];
  assertCallerCurrent: () => void;
}) {
  let active = true;
  const retained: Array<{
    read: Read;
    sessionId: string;
    lifecycleRevision: string | undefined;
    parent: string | undefined;
    ancestor: boolean;
    expected?: Ancestor;
  }> = [];
  const changed = () =>
    new SessionMutationAuthorizationChangedError(sessionChangedError(params.key));
  const parentKey = (entry: { parentSessionKey?: string; spawnedBy?: string }) =>
    normalizeOptionalString(entry.parentSessionKey) ?? normalizeOptionalString(entry.spawnedBy);
  const release = () => {
    active = false;
    for (const { read } of retained.splice(0).toReversed()) {
      read.release();
    }
  };
  const assertCurrent = () => {
    params.assertCallerCurrent();
    if (!active) {
      throw changed();
    }
    try {
      const cfg = params.getCurrentConfig();
      for (const { read, sessionId, lifecycleRevision, parent, ancestor, expected } of retained) {
        const entry = read.readCurrent(cfg).target?.entry;
        if (
          !entry ||
          entry.sessionId !== sessionId ||
          entry.lifecycleRevision !== lifecycleRevision ||
          parentKey(entry) !== parent ||
          (ancestor && entry.archivedAt !== undefined) ||
          (expected &&
            (entry.sessionId !== expected.expectedSessionId ||
              (entry.sidebarRoot === true) !== expected.expectedSidebarRoot ||
              (entry.category ?? null) !== expected.expectedCategory))
        ) {
          throw changed();
        }
      }
    } catch {
      // Missing, inaccessible storage and mismatched paths share one target-local refusal.
      throw changed();
    }
  };
  try {
    let key: string | undefined = params.key;
    let agentId = params.agentId;
    let matched = 0;
    const visited = new Set<string>();
    while (key && (retained.length === 0 || matched < params.ancestors.length)) {
      assertCurrent();
      const identity = agentId + "\0" + key;
      if (visited.has(identity) || retained.length >= 256) {
        throw changed();
      }
      visited.add(identity);
      const read = await prepareSessionMutationFacts({ cfg: params.cfg, sessionKey: key, agentId });
      let adopted = false;
      try {
        assertCurrent();
        const target = read.readCurrent(params.getCurrentConfig()).target;
        if (!target) {
          throw changed();
        }
        const expected =
          retained.length > 0 && !isSubagentSessionKey(target.canonicalKey)
            ? params.ancestors[matched++]
            : undefined;
        if (
          expected &&
          (expected.key.trim() !== target.canonicalKey ||
            (expected.agentId !== undefined && expected.agentId !== target.agentId))
        ) {
          throw changed();
        }
        retained.push({
          read,
          sessionId: target.entry.sessionId,
          lifecycleRevision: target.entry.lifecycleRevision,
          parent: parentKey(target.entry),
          ancestor: retained.length > 0,
          expected,
        });
        adopted = true;
        key = parentKey(target.entry);
        agentId = parseAgentSessionKey(key)?.agentId ?? target.agentId;
      } finally {
        if (!adopted) {
          read.release();
        }
      }
    }
    if (matched !== params.ancestors.length) {
      throw changed();
    }
    assertCurrent();
    return { assertCurrent, release };
  } catch (error) {
    release();
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    throw changed();
  }
}
