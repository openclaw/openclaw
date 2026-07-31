import { resolveStorePath } from "./paths.js";

/** Whether session.store resolves to a distinct store for each agent. */
export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  const normalized = storeConfig?.trim();
  return !normalized || normalized.includes("{agentId}");
}

/** Whether two configs select the same fixed physical session store. */
export function isSameFixedSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    !isPerAgentSessionStoreConfig(source) &&
    !isPerAgentSessionStoreConfig(target) &&
    resolveStorePath(source, { env }) === resolveStorePath(target, { env })
  );
}
