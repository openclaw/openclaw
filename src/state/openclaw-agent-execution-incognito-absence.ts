import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { AgentDatabaseIncognitoAuthority } from "./openclaw-agent-execution-contract.js";

/** Only active consumer scopes are retained; the execution owner supplies namespace occupancy. */
export function createIncognitoAbsenceScopes(isOccupied: (pathname: string) => boolean) {
  const sources = new Set<{ path: string; revoke(): void }>();
  return {
    revoke(pathname: string) {
      for (const source of sources) {
        if (source.path === pathname) {
          source.revoke();
        }
      }
    },
    capture(
      this: void,
      options: { agentId: string; env: NodeJS.ProcessEnv },
      authority: AgentDatabaseIncognitoAuthority,
    ) {
      const agentId = normalizeAgentId(options.agentId);
      const env = { ...options.env, OPENCLAW_STATE_DIR: resolveStateDir(options.env) };
      const pathname = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
      let active = true;
      const assertCurrent = () => {
        authority.assertCurrent();
        if (!active || isOccupied(pathname)) {
          throw new Error("Incognito session absence changed; prepare the source again");
        }
      };
      assertCurrent();
      const source = {
        path: pathname,
        revoke() {
          active = false;
        },
      };
      sources.add(source);
      return {
        agentId,
        path: pathname,
        env,
        assertCurrent,
        release(this: void) {
          source.revoke();
          sources.delete(source);
        },
      };
    },
  };
}
