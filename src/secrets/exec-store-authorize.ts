/**
 * Assignment authorization for the exec secret-store projection.
 *
 * Runs after core resolves the team-store exec snapshot and before that
 * snapshot becomes the executable environment. Policy is plugin-owned; this
 * module only knows how to ask registered `secret_env_authorize` handlers
 * whether the resolved projection is authorized, and how to enforce a
 * most-restrictive intersection.
 *
 * Guarantees:
 * - The event carries resolved entry NAMES and kinds only; never values.
 * - Handlers can only ever narrow the projection, never widen it.
 * - Fail-closed: a handler error/timeout, or a registered hook that returns no
 *   decision, denies the projection. It never silently widens.
 * - With no registered handlers, the snapshot is returned unchanged.
 * - The authorized name set is bound to the run and re-checked at the spawn
 *   boundary so a revocation during a deferred approval cannot leak.
 */
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type {
  PluginHookSecretEnvAuthorizeContext,
  PluginHookSecretEnvAuthorizeEvent,
} from "../plugins/hook-types.js";
import type { SecretStoreExecEnvironment } from "./store/secret-store.js";

export type SecretEnvAuthorizationResult =
  | { ok: true; storeEnv: SecretStoreExecEnvironment; recheck?: () => Promise<string | undefined> }
  | { ok: false };

type Decision =
  // No hook is registered at all: legacy behavior, project nothing extra.
  | { kind: "no-hooks" }
  // A hook is registered but produced no decision: fail closed.
  | { kind: "no-decision" }
  | { kind: "decision"; allowed: ReadonlySet<string> };

/** Collects the entry names present in a resolved store snapshot. */
function candidateNames(storeEnv: SecretStoreExecEnvironment): {
  names: Set<string>;
  candidates: { name: string; kind: "secret" | "env" }[];
} {
  const names = new Set<string>();
  const candidates: { name: string; kind: "secret" | "env" }[] = [];
  for (const name of Object.keys(storeEnv.env ?? {})) {
    names.add(name);
    candidates.push({ name, kind: "env" });
  }
  for (const name of Object.keys(storeEnv.secretSentinels ?? {})) {
    names.add(name);
    candidates.push({ name, kind: "secret" });
  }
  return { names, candidates };
}

/**
 * Restricts a resolved snapshot to `allowed`, preserving shape and dropping
 * empty groups. Egress bindings follow `secretSentinels` so the two never drift.
 */
function restrictStoreEnv(
  storeEnv: SecretStoreExecEnvironment,
  allowed: ReadonlySet<string>,
): SecretStoreExecEnvironment {
  const env = storeEnv.env
    ? Object.fromEntries(Object.entries(storeEnv.env).filter(([name]) => allowed.has(name)))
    : undefined;
  const secretSentinels = storeEnv.secretSentinels
    ? Object.fromEntries(
        Object.entries(storeEnv.secretSentinels).filter(([name]) => allowed.has(name)),
      )
    : undefined;
  const secretEgressBindings = storeEnv.secretEgressBindings?.filter((binding) =>
    allowed.has(binding.name),
  );
  return {
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(secretSentinels && Object.keys(secretSentinels).length > 0 ? { secretSentinels } : {}),
    ...(secretEgressBindings && secretEgressBindings.length > 0 ? { secretEgressBindings } : {}),
  };
}

/**
 * Resolves the run-bound authorization decision. A runner error propagates to
 * the caller, which fails closed; a registered hook that returns nothing is
 * reported as `no-decision` so the caller can deny rather than widen.
 */
async function decide(params: {
  event: PluginHookSecretEnvAuthorizeEvent;
  ctx: PluginHookSecretEnvAuthorizeContext;
}): Promise<Decision> {
  const hookRunner = getGlobalHookRunner();
  if (
    !hookRunner?.hasHooks("secret_env_authorize") ||
    typeof hookRunner.runSecretEnvAuthorize !== "function"
  ) {
    return { kind: "no-hooks" };
  }
  const result = await hookRunner.runSecretEnvAuthorize(params.event, params.ctx);
  if (!result) {
    return { kind: "no-decision" };
  }
  return { kind: "decision", allowed: new Set(result.allowedNames) };
}

/** Authorizes (and optionally narrows) the resolved exec secret projection. */
export async function authorizeSecretEnvProjection(params: {
  storeEnv: SecretStoreExecEnvironment;
  host: "gateway" | "sandbox" | "node";
  sessionKey?: string;
  ctx: PluginHookSecretEnvAuthorizeContext;
}): Promise<SecretEnvAuthorizationResult> {
  const { names, candidates } = candidateNames(params.storeEnv);
  if (candidates.length === 0) {
    return { ok: true, storeEnv: params.storeEnv };
  }
  const event: PluginHookSecretEnvAuthorizeEvent = {
    toolName: "exec",
    host: params.host,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    candidates,
  };

  let firstDecision: Decision;
  try {
    firstDecision = await decide({ event, ctx: params.ctx });
  } catch {
    // Fail closed: a throwing or timing-out policy denies the projection.
    return { ok: false };
  }
  if (firstDecision.kind === "no-hooks") {
    const recheck = async (): Promise<string | undefined> => {
      let live: Decision;
      try {
        live = await decide({ event, ctx: params.ctx });
      } catch {
        return "secret assignment policy failed to re-validate this run";
      }
      if (live.kind === "no-decision") {
        return "secret assignment policy produced no decision on re-validation";
      }
      if (live.kind === "decision" && [...names].some((name) => !live.allowed.has(name))) {
        return "secret assignment policy revoked one or more entries for this run";
      }
      return undefined;
    };
    return { ok: true, storeEnv: params.storeEnv, recheck };
  }
  if (firstDecision.kind === "no-decision") {
    return { ok: false };
  }

  // Per-entry enforcement: a resolved name the policy did not authorize is
  // withheld from the projection. Names the policy returns that core did not
  // resolve have no effect (intersection with `names`).
  const effective = new Set([...firstDecision.allowed].filter((name) => names.has(name)));
  const projected = [...effective];

  const recheck = async (): Promise<string | undefined> => {
    let live: Decision;
    try {
      live = await decide({ event, ctx: params.ctx });
    } catch {
      return "secret assignment policy failed to re-validate this run";
    }
    if (live.kind === "no-decision") {
      return "secret assignment policy produced no decision on re-validation";
    }
    // A deregistered hook revokes nothing; keep the already-projected subset.
    if (live.kind === "no-hooks") {
      return undefined;
    }
    // Re-validate only the names actually projected for this run.
    if (projected.some((name) => !live.allowed.has(name))) {
      return "secret assignment policy revoked one or more entries for this run";
    }
    return undefined;
  };

  return { ok: true, storeEnv: restrictStoreEnv(params.storeEnv, effective), recheck };
}
