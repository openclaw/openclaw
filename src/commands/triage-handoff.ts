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
  const stdin = promptPath ? { stdinPath: promptPath, env } : { env };
  const external = {
    claude: formatInstallationTargetCommand(
      ["claude", "-p", ...(promptPath ? [] : [prompt])],
      target,
      stdin,
    ),
    codex: formatInstallationTargetCommand(
      ["codex", "exec", "--skip-git-repo-check", promptPath ? "-" : prompt],
      target,
      stdin,
    ),
    cursor: formatInstallationTargetCommand(
      ["cursor-agent", "--print", ...(promptPath ? [] : [prompt])],
      target,
      stdin,
    ),
    grok: formatInstallationTargetCommand(
      ["grok", ...(promptPath ? ["--prompt-file", promptPath] : ["--single", prompt])],
      target,
      { env },
    ),
    kimi: formatInstallationTargetCommand(
      [
        "kimi",
        "--prompt",
        promptPath
          ? `Read the debugging prompt at ${promptPath} and follow its repair and verification instructions.`
          : prompt,
      ],
      target,
      { env },
    ),
    muse: formatInstallationTargetCommand(
      ["muse", "exec", ...(promptPath ? ["--prompt-file", promptPath] : [prompt])],
      target,
      { env },
    ),
    opencode: formatInstallationTargetCommand(
      ["opencode", "run", ...(promptPath ? [] : [prompt])],
      target,
      stdin,
    ),
    pi: formatInstallationTargetCommand(
      ["pi", "--print", ...(promptPath ? [] : [prompt])],
      target,
      stdin,
    ),
    qwen: formatInstallationTargetCommand(["qwen", ...(promptPath ? [] : [prompt])], target, stdin),
  };
  const failureArgs = updateResultPath ? ["--update-result", updateResultPath] : [];
  return {
    external,
    embedded: formatInstallationTargetCommand(
      ["openclaw", "triage", "--run", ...failureArgs],
      target,
      {
        env,
      },
    ),
    retry: formatInstallationTargetCommand(
      ["openclaw", "triage", ...(params.agent ? ["--agent", params.agent] : []), ...failureArgs],
      target,
      { env },
    ),
  };
}
