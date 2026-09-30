import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.sqlite-entry-list.read.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { SessionGroupMembershipSnapshot } from "./session-group-catalog.types.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";

/** Discovery runs on a read worker; mutation guards call it inside their owning transaction. */
export function readSessionGroupMembership(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SessionGroupMembershipSnapshot {
  const stores = resolveAllAgentSessionStoreTargetsSync(cfg, { env }).map((target) => {
    const resolved = resolveSqliteReadScope({ ...target, env });
    const options = toDatabaseOptions(resolved);
    return { agentId: target.agentId, storePath: resolveOpenClawAgentSqlitePath(options) };
  });
  const groups = new Map<string, SessionMutationTarget[]>();
  for (const store of stores) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      ...store,
      env,
      projection: "list",
      clone: false,
    })) {
      const name = normalizeOptionalString(entry.category);
      if (name) {
        const members = groups.get(name) ?? [];
        members.push({ sessionKey, agentId: store.agentId });
        groups.set(name, members);
      }
    }
  }
  return { stores, groups: [...groups] };
}
