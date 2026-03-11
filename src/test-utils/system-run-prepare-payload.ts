import { formatExecCommand } from "../infra/system-run-command.js";

type SystemRunPrepareInput = {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
};

export function buildSystemRunPreparePayload(params: SystemRunPrepareInput) {
  const argv = Array.isArray(params.command) ? params.command.map(String) : [];
  const rawCommand =
    typeof params.rawCommand === "string" && params.rawCommand.trim().length > 0
      ? params.rawCommand
      : null;
  const formattedArgv = formatExecCommand(argv) || null;
  const commandPreview = rawCommand && rawCommand !== formattedArgv ? rawCommand : null;
  return {
    payload: {
      cmdText: rawCommand ?? argv.join(" "),
      plan: {
        argv,
        cwd: typeof params.cwd === "string" ? params.cwd : null,
        rawCommand: formattedArgv,
        commandPreview,
        agentId: typeof params.agentId === "string" ? params.agentId : null,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
      },
    },
  };
}
