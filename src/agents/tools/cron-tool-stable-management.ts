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
 * A session that received the full ("also") declaration keeps it on its
 * ungranted turns and on management-only continuations. Only that declaration
 * is remembered: it contains every action an ungranted or management-only turn
 * declares, so the remembered surface is never narrower than what the turn may
 * do. Execution still reads only the current turn's grant, so this never widens
 * access: arguments the current turn may not use are refused exactly as before.
 */
export function createStableCronManagementDeclaration() {
  const fullDeclarations = new Set<string>();
  return {
    resolve(
      sessionKey: string | undefined,
      current: CronManagementDeclaration | undefined,
    ): CronManagementDeclaration | undefined {
      const key = sessionKey?.trim();
      if (!key) {
        return current;
      }
      if (current === "also" || fullDeclarations.has(key)) {
        fullDeclarations.delete(key);
        fullDeclarations.add(key);
        if (fullDeclarations.size > MAX_REMEMBERED_SESSIONS) {
          fullDeclarations.delete(fullDeclarations.values().next().value!);
        }
        return "also";
      }
      return current;
    },
    clear() {
      fullDeclarations.clear();
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
