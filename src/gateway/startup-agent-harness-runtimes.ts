import { normalizeAgentHarnessRuntimeId } from "../agents/harness-runtimes.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

function isStartupAgentHarnessRuntime(runtime: string | undefined): runtime is string {
  return Boolean(runtime && runtime !== "auto" && runtime !== "pi");
}

export function collectGatewayStartupSessionAgentHarnessRuntimes(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const runtimes = new Set<string>();
  const seenStorePaths = new Set<string>();
  const env = params.env ?? process.env;

  for (const agent of listGatewayAgentsBasic(params.config).agents) {
    const storePath = resolveStorePath(params.config.session?.store, {
      agentId: agent.id,
      env,
    });
    if (seenStorePaths.has(storePath)) {
      continue;
    }
    seenStorePaths.add(storePath);

    const store = readSessionStoreReadOnly(storePath);
    for (const entry of Object.values(store)) {
      const runtime = normalizeAgentHarnessRuntimeId(entry?.agentHarnessId);
      if (isStartupAgentHarnessRuntime(runtime)) {
        runtimes.add(runtime);
      }
    }
  }

  return [...runtimes].toSorted((left, right) => left.localeCompare(right));
}
