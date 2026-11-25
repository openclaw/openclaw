import path from "node:path";
import { tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveSessionStorePathCore,
} from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type RuntimeDirLabel = "Sessions dir" | "Session store dir" | "OAuth dir";

export function resolveSessionRuntimeDirectories(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): Map<string, RuntimeDirLabel> {
  const directories = new Map<string, RuntimeDirLabel>();
  const agentId = tryResolveDefaultAgentId(cfg);
  if (agentId) {
    directories.set(resolveSessionTranscriptsDirForAgent(agentId, env, homedir), "Sessions dir");
    directories.set(
      path.dirname(resolveSessionStorePathCore(cfg.session?.store, { agentId, env })),
      "Session store dir",
    );
  }
  return directories;
}
