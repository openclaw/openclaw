import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { withoutStateDatabaseWorkerAccess } from "../../infra/state-database-worker-access.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type PluginWorkspaceParams = Omit<
  NonNullable<Parameters<typeof ensureAgentWorkspace>[0]>,
  "guard"
> & {
  guard?: { assertHost?: () => void };
  /** @deprecated Use guard.assertHost for SQL-free live authority; await database preparation first. */
  beforePersistentApply?: () => void;
};

export function ensurePluginAgentWorkspace(params?: PluginWorkspaceParams) {
  const legacy = params?.beforePersistentApply;
  if (!legacy) {
    return ensureAgentWorkspace(params);
  }
  // Auxiliary attestation may ignore storage errors; a callback refusal stays fatal.
  let refusal: { error: unknown } | undefined;
  resolveGlobalSingleton(Symbol.for("openclaw.workspaceGuardDeprecation"), () => {
    process.emitWarning(
      "ensureAgentWorkspace.beforePersistentApply is deprecated; use guard.assertHost. Removal: next Plugin SDK major.",
      { code: "DEP_WORKSPACE_MUTATION_GUARD", type: "DeprecationWarning" },
    );
    return true;
  });
  return ensureAgentWorkspace({
    ...params,
    guard: {
      assertHost() {
        if (refusal) {
          throw refusal.error;
        }
        try {
          params?.guard?.assertHost?.();
          withoutStateDatabaseWorkerAccess(
            "ensureAgentWorkspace.beforePersistentApply: synchronous OpenClaw DB access is not allowed in beforePersistentApply; await database preparation before ensureAgentWorkspace and use SQL-free guard.assertHost.",
            legacy,
          );
        } catch (error) {
          refusal = { error };
          throw error;
        }
      },
    },
  });
}
