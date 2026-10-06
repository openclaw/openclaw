import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import type { InstallationTarget } from "../infra/installation-target-context.js";

export const TRIAGE_EXTERNAL_AGENTS = [
  "codex",
  "claude",
  "pi",
  "opencode",
  "muse",
  "grok",
  "cursor",
  "kimi",
  "qwen",
] as const;
export type TriageExternalAgent = (typeof TRIAGE_EXTERNAL_AGENTS)[number];

/** Keep executable manual commands and the complete JSON handoff pinned to the same target. */
export function formatTriageHandoffCommands(params: {
  target: InstallationTarget;
  env: NodeJS.ProcessEnv;
  prompt: string;
  promptPath: string | null;
  updateResultPath?: string;
  agent?: TriageExternalAgent;
}) {
  const { target, env, prompt, promptPath, updateResultPath } = params;
  const format = (argv: string[], stdinPath?: string | null) =>
    formatInstallationTargetCommand(argv, target, {
      env,
      ...(stdinPath ? { stdinPath } : {}),
    });
  const external = {
    claude: format(["claude", "-p", ...(promptPath ? [] : [prompt])], promptPath),
    codex: format(
      ["codex", "exec", "--skip-git-repo-check", promptPath ? "-" : prompt],
      promptPath,
    ),
    cursor: format(["cursor-agent", "--print", ...(promptPath ? [] : [prompt])], promptPath),
    grok: format(["grok", ...(promptPath ? ["--prompt-file", promptPath] : ["--single", prompt])]),
    kimi: format([
      "kimi",
      "--prompt",
      promptPath
        ? `Read the debugging prompt at ${promptPath} and follow its repair and verification instructions.`
        : prompt,
    ]),
    muse: format(["muse", "exec", ...(promptPath ? ["--prompt-file", promptPath] : [prompt])]),
    opencode: format(["opencode", "run", ...(promptPath ? [] : [prompt])], promptPath),
    pi: format(["pi", "--print", ...(promptPath ? [] : [prompt])], promptPath),
    qwen: format(["qwen", ...(promptPath ? [] : [prompt])], promptPath),
  };
  const failureArgs = updateResultPath ? ["--update-result", updateResultPath] : [];
  return {
    external,
    embedded: format(["openclaw", "triage", "--run", ...failureArgs]),
    retry: format([
      "openclaw",
      "triage",
      ...(params.agent ? ["--agent", params.agent] : []),
      ...failureArgs,
    ]),
  };
}
