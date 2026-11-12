import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import {
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "../operator-scopes.js";

/** Ordinary editable definitions installed when OpenClaw ID is activated. */
export const MEMBER_ROLE_PRESETS: Record<"operator" | "viewer", GatewayOperatorRoleDefinition> = {
  operator: {
    sessions: { others: "write" },
    agents: "*",
    scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE, QUESTIONS_SCOPE, TALK_SCOPE],
  },
  viewer: {
    sessions: { others: "view" },
    agents: "*",
    scopes: [SESSION_READ_SCOPE],
  },
};

/** Seeds once per activation, never on ordinary definition edits or deletions. */
export function createMemberRolePresetActivation(log: { warn: (message: string) => void }) {
  let active = false;
  let failure: string | undefined;
  return {
    error: () => failure,
    async reconcile(enabled: boolean): Promise<void> {
      if (active === enabled) {
        return;
      }
      active = enabled;
      failure = undefined;
      if (!enabled) {
        return;
      }
      try {
        const { replaceConfigFile, withConfigMutationExclusive } =
          await import("../../config/mutate.js");
        await withConfigMutationExclusive(async (config) => {
          // Read the latest authored config under its normal writer lock.
          if (!isOpenClawIdEnabled(config.gateway?.openclawId)) {
            return;
          }
          const roles = config.gateway?.roles;
          const missing = Object.entries(MEMBER_ROLE_PRESETS).filter(
            ([name]) => !Object.hasOwn(roles?.definitions ?? {}, name),
          );
          if (!missing.length) {
            return;
          }
          await replaceConfigFile({
            sourceConfig: {
              ...config,
              gateway: {
                ...config.gateway,
                roles: {
                  ...roles,
                  definitions: {
                    ...roles?.definitions,
                    ...structuredClone(Object.fromEntries(missing)),
                  },
                },
              },
            },
            // Reconcile can run inside a managed reload. Publish the write but
            // never wait for the recursive runtime-application receipt here.
            afterWrite: { mode: "auto" },
          });
        });
      } catch (error) {
        failure = `Could not save OpenClaw ID member role presets: ${String(error)}. Fix the config write failure, then restart the Gateway or turn OpenClaw ID off and on.`;
        log.warn(`openclaw-id: ${failure}`);
      }
    },
  };
}
