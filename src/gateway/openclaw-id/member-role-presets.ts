import { logConfigWarningsOnce } from "../../config/io.warnings.js";
import { resolveConfigPath } from "../../config/paths.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  SESSION_READ_SCOPE,
  SESSION_WRITE_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "../operator-scopes.js";
import { openClawIdAccessWarning } from "./access-plugin.js";
import type { OpenClawIdStatus } from "./service-status.js";

/**
 * Ordinary editable definitions installed when OpenClaw ID is activated. `admin` gives the
 * Roles page a role to hand administrators before a default role puts everyone under roles.
 */
const MEMBER_ROLE_PRESETS: Record<
  "admin" | "operator" | "viewer" | "guest",
  GatewayOperatorRoleDefinition
> = {
  admin: {
    sessions: { others: "write" },
    agents: "*",
    scopes: [ADMIN_SCOPE],
  },
  operator: {
    sessions: { others: "write" },
    agents: "*",
    scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE, QUESTIONS_SCOPE, TALK_SCOPE],
  },
  guest: {
    sessions: { others: "invited", maxInvitedAccess: "send" },
    agents: "*",
    scopes: [SESSION_READ_SCOPE, SESSION_WRITE_SCOPE],
    sandbox: "required",
  },
  viewer: {
    sessions: { others: "view" },
    agents: "*",
    scopes: [SESSION_READ_SCOPE],
  },
};

function missingMemberRolePresets(config: OpenClawConfig) {
  return Object.entries(MEMBER_ROLE_PRESETS).filter(
    ([name]) => !Object.hasOwn(config.gateway?.roles?.definitions ?? {}, name),
  );
}

/** Names needed by diagnostics; preset definitions remain owned by this module. */
export function listMissingMemberRolePresets(config: OpenClawConfig): string[] {
  return missingMemberRolePresets(config).map(([name]) => name);
}

/** Shared activation/Doctor transform: add missing presets without changing existing policy. */
export function withMissingMemberRolePresets(config: OpenClawConfig): OpenClawConfig {
  if (!isOpenClawIdEnabled(config.gateway?.openclawId)) {
    return config;
  }
  const roles = config.gateway?.roles;
  const missing = missingMemberRolePresets(config);
  if (!missing.length) {
    return config;
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      roles: {
        ...roles,
        definitions: { ...roles?.definitions, ...structuredClone(Object.fromEntries(missing)) },
      },
    },
  };
}

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
    async reconcile(
      enabled: boolean,
      observedConfig = getRuntimeConfigSnapshot(),
    ): Promise<boolean> {
      const warning =
        enabled && observedConfig ? openClawIdAccessWarning(observedConfig) : undefined;
      // Hand-edited/immutable config must stay untouched when Access is blocked.
      // Doctor owns the consented allowlist repair.
      if (warning) {
        logConfigWarningsOnce({
          configPath: resolveConfigPath(),
          warnings: [{ path: "gateway.openclawId.enabled", message: warning }],
          logger: log,
        });
        return false;
      }
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
          const sourceConfig = withMissingMemberRolePresets(config);
          if (sourceConfig === config) {
            return false;
          }
          await replaceConfigFile({
            sourceConfig,
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
