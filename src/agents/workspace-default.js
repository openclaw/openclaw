import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function resolveDefaultAgentWorkspaceDir(env = process.env, homedir = os.homedir) {
    const home = resolveRequiredHomeDir(env, homedir);
    const profile = env.OPENCLAW_PROFILE?.trim();
    if (profile && normalizeOptionalLowercaseString(profile) !== "default") {
        return path.join(home, ".openclaw", `workspace-${profile}`);
    }
    return path.join(home, ".openclaw", "workspace");
}
export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
