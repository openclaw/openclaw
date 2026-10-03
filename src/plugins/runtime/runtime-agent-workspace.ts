import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type PluginWorkspaceParams = Omit<
  NonNullable<Parameters<typeof ensureAgentWorkspace>[0]>,
  "guard"
> & {
  guard?: { assertHost?: () => void };
  /** @deprecated Runs before dispatch. Use SQL-free guard.assertHost for live commit authority. */
  beforePersistentApply?: () => void;
};

export function ensurePluginAgentWorkspace(params?: PluginWorkspaceParams) {
  const legacy = params?.beforePersistentApply;
  if (!legacy) {
    return ensureAgentWorkspace(params);
  }
  // Auxiliary attestation may ignore storage errors; a callback refusal stays fatal.
  let refusal: { error: unknown } | undefined;
  const check = (assertAllowed?: () => void) => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      assertAllowed?.();
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
  resolveGlobalSingleton(Symbol.for("openclaw.workspaceGuardDeprecation"), () => {
    process.emitWarning(
      "ensureAgentWorkspace.beforePersistentApply runs before dispatch; synchronous OpenClaw DB access in this callback is deprecated. Use SQL-free guard.assertHost for live revocation at commit. Removal: next Plugin SDK major.",
      { code: "DEP_WORKSPACE_MUTATION_GUARD", type: "DeprecationWarning" },
    );
    return true;
  });
  return ensureAgentWorkspace({
    ...params,
    guard: {
      assertHost: () => check(params?.guard?.assertHost),
      beforeLegacyApply: () => check(legacy),
    },
  });
}
