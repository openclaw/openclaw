import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import {
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "../operator-scopes.js";
import type { OpenClawIdStatus } from "./service-status.js";

/** Ordinary editable definitions installed when OpenClaw ID is activated. */
const MEMBER_ROLE_PRESETS: Record<"operator" | "viewer", GatewayOperatorRoleDefinition> = {
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
  let activationRequiresRestart = false;
  return {
    /** Observe saved-but-unapplied activation through the existing config owner. */
    observeConfigApplication(this: void, config: OpenClawConfig, runtimeApplied: boolean): void {
      const liveConfig = getRuntimeConfigSnapshot();
      const liveDefinitions = liveConfig?.gateway?.roles?.definitions;
      activationRequiresRestart =
        !runtimeApplied &&
        isOpenClawIdEnabled(config.gateway?.openclawId) &&
        (!isOpenClawIdEnabled(liveConfig?.gateway?.openclawId) ||
          Object.keys(MEMBER_ROLE_PRESETS).some(
            (name) =>
              Object.hasOwn(config.gateway?.roles?.definitions ?? {}, name) &&
              !Object.hasOwn(liveDefinitions ?? {}, name),
          ));
    },
    status(status: OpenClawIdStatus): OpenClawIdStatus {
      if (activationRequiresRestart) {
        return {
          state: "failed",
          reason:
            "Restart the Gateway to finish turning on OpenClaw ID member roles; the saved config has not been applied.",
        };
      }
      return failure && status.state !== "off" ? { state: "failed", reason: failure } : status;
    },
    async reconcile(enabled: boolean): Promise<boolean> {
      if (active === enabled) {
        return false;
      }
      active = enabled;
      failure = undefined;
      if (!enabled) {
        return false;
      }
      try {
        const { replaceConfigFile, withConfigMutationExclusive } =
          await import("../../config/mutate.js");
        return await withConfigMutationExclusive(async (config) => {
          // Read the latest authored config under its normal writer lock.
          if (!isOpenClawIdEnabled(config.gateway?.openclawId)) {
            return false;
          }
          const roles = config.gateway?.roles;
          const missing = Object.entries(MEMBER_ROLE_PRESETS).filter(
            ([name]) => !Object.hasOwn(roles?.definitions ?? {}, name),
          );
          if (!missing.length) {
            return false;
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
          return true;
        });
      } catch (error) {
        failure = `Could not save OpenClaw ID member role presets: ${String(error)}. Fix the config write failure, then restart the Gateway or turn OpenClaw ID off and on.`;
        log.warn(`openclaw-id: ${failure}`);
        return false;
      }
    },
  };
}
