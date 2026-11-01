import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { AsyncContext } from "../shared/async-context.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export type AgentDatabasePreparation = {
  readonly hasPendingAgents: boolean;
  isAgentInputRecoveryPending(agentId: string): boolean;
  waitForAgentPreparation(
    agentId: string,
    options?: {
      env?: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      forWrite?: boolean;
      forInput?: boolean;
    },
  ): Promise<void> | undefined;
};

const preparation = new AsyncContext<() => AgentDatabasePreparation | undefined>(
  Symbol("agentDatabasePreparation"),
);
const inputRecovery = new AsyncContext<{
  owner: AgentDatabasePreparation;
  agentId: string;
  active: boolean;
}>(Symbol("agentInputRecovery"));

/** Recovery's own admission can cross its input wait, never native database admission. */
export async function withAgentInputRecovery<T>(
  owner: AgentDatabasePreparation | undefined,
  agentId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!owner) {
    return run();
  }
  const scope = { owner, agentId: normalizeAgentId(agentId), active: true };
  try {
    return await inputRecovery.run(scope, run);
  } finally {
    // Descendants resume ordinary observation after queue custody has transferred.
    scope.active = false;
  }
}

/** Carry readiness observation without borrowing startup's database access. */
export function withAgentDatabasePreparationContext<T>(
  resolveOwner: () => AgentDatabasePreparation | undefined,
  run: () => T,
): T {
  return preparation.getStore() === resolveOwner ? run() : preparation.run(resolveOwner, run);
}

export function waitForAgentDatabasePreparation(
  agentId: string,
  options?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<void> | undefined {
  return preparation.getStore()?.()?.waitForAgentPreparation(agentId, options);
}

/** Wait before acquiring write/session authority; startup alone owns the completion and budget. */
export function waitForAgentDatabaseWriteAdmission(
  agentId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    owner?: AgentDatabasePreparation;
  } = {},
): Promise<void> | undefined {
  const signals = [options.signal, getAsyncWorkSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return (options.owner ?? preparation.getStore()?.())?.waitForAgentPreparation(agentId, {
    env: options.env,
    signal: signals.length ? AbortSignal.any(signals) : undefined,
    forWrite: true,
  });
}

/** Wait for the logical agent's database and the selected physical store's retained inputs. */
export function waitForAgentInputAdmission(
  agentId: string,
  options: (
    | { cfg: OpenClawConfig; storePath?: string }
    | { cfg?: undefined; storePath: string }
  ) & {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    owner?: AgentDatabasePreparation;
  },
): Promise<void> | undefined {
  const owner = options.owner ?? preparation.getStore()?.();
  if (!owner?.hasPendingAgents) {
    return undefined;
  }
  const signals = [options.signal, getAsyncWorkSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const wait = (selected: string) => {
    const recovery = inputRecovery.getStore();
    return owner.waitForAgentPreparation(selected, {
      env: options.env,
      signal,
      forWrite: true,
      forInput: !(
        recovery?.active &&
        recovery.owner === owner &&
        recovery.agentId === normalizeAgentId(selected)
      ),
    });
  };
  return (async () => {
    await owner.waitForAgentPreparation(agentId, { env: options.env, signal, forWrite: true });
    if (!owner.hasPendingAgents || (!options.storePath && !options.cfg?.session?.store)) {
      await wait(agentId);
      return;
    }
    const { isPerAgentSessionStoreConfig } =
      await import("../config/sessions/session-store-config.js");
    const [
      { prepareSqliteTargetFromSessionStorePath },
      { resolveSessionStorePathCore },
      { resolveSessionStoreCompatibilityAgentId },
    ] = await Promise.all([
      import("../config/sessions/session-sqlite-target.js"),
      import("../config/sessions/paths.js"),
      import("../config/legacy.default-agent-owner.js"),
    ]);
    const target = await prepareSqliteTargetFromSessionStorePath(
      options.storePath ??
        resolveSessionStorePathCore(options.cfg?.session?.store, { agentId, env: options.env }),
      {
        agentId,
        env: options.env,
        defaultAgentId:
          !options.cfg || isPerAgentSessionStoreConfig(options.cfg.session?.store)
            ? agentId
            : resolveSessionStoreCompatibilityAgentId(options.cfg),
      },
      signal,
    );
    await wait(target.agentId ?? agentId);
  })();
}
