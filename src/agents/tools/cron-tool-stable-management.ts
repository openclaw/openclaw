import { isCronModelManagementAllowed } from "../../gateway/cron-creator-authority-grant.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { CronToolOptions } from "./cron-tool.types.js";

const MAX_REMEMBERED_SESSIONS = 512;

export type CronManagementDeclaration = "only" | "also";

/**
 * Keeps the Automations declaration stable across a session's native turns.
 *
 * Only an admitted operator turn binds the cron management grant, so completion
 * and other internal turns would otherwise publish a narrower Automations schema
 * and a native runtime would replace its thread for a changed tool catalog.
 * Turns without a grant reuse the session's last granted declaration, and a
 * management-only continuation keeps a wider declaration the session already
 * holds. Execution still reads only the current turn's grant, so this never
 * widens access: arguments the current turn may not use are refused exactly as
 * before.
 */
export function createStableCronManagementDeclaration() {
  const declarations = new Map<string, CronManagementDeclaration>();
  return {
    resolve(
      sessionKey: string | undefined,
      current: CronManagementDeclaration | undefined,
    ): CronManagementDeclaration | undefined {
      const key = sessionKey?.trim();
      if (!key) {
        return current;
      }
      if (current) {
        const declared = current === "only" && declarations.get(key) === "also" ? "also" : current;
        declarations.delete(key);
        declarations.set(key, declared);
        if (declarations.size > MAX_REMEMBERED_SESSIONS) {
          declarations.delete(declarations.keys().next().value!);
        }
        return declared;
      }
      return declarations.get(key);
    },
    clear() {
      declarations.clear();
    },
  };
}

/** Process-wide declarations shared by every runtime that builds the Automations tool. */
export const stableCronManagementDeclaration = createStableCronManagementDeclaration();

/** Resolves the Automations surface a turn declares; execution keeps using the live grant. */
export function declareCronTool(
  opts: Pick<CronToolOptions, "agentSessionKey" | "selfRemoveOnlyJobId"> | undefined,
  config: Parameters<typeof isCronModelManagementAllowed>[0],
  grant: { managementOnly: boolean } | undefined,
): { selfRemoveOnly: boolean; management: CronManagementDeclaration | undefined } {
  // Conversation continuations keep their catalog; the execution guard still scopes each call.
  const selfRemoveOnly =
    Boolean(opts?.selfRemoveOnlyJobId?.trim()) &&
    (!opts?.agentSessionKey?.trim() || isCronSessionKey(opts.agentSessionKey));
  const current = grant && (grant.managementOnly ? "only" : "also");
  const management =
    !selfRemoveOnly && isCronModelManagementAllowed(config)
      ? stableCronManagementDeclaration.resolve(opts?.agentSessionKey, current)
      : current;
  return { selfRemoveOnly, management };
}
