import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { createAgentTeam } from "../agents/agent-team.js";
import { formatCliCommand } from "../cli/command-format.js";
import { throwExpectedCliError } from "../cli/failure-output.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import { displayPath } from "../utils.js";

export async function agentsTeamCreateCommand(opts: {
  preset?: string;
  coordinator?: string;
  prefix?: string;
  workspaceRoot?: string;
  nonInteractive?: boolean;
  json?: boolean;
}): Promise<void> {
  const result = await runWithLocalStateOwner({
    method: "agents.team.create",
    params: {},
    target: "agent team",
    onForeignOwner: "refuse",
    runLocal: () => createAgentTeam(opts),
  });
  if (result.status === "error") {
    throwExpectedCliError(result.message);
  }
  const note =
    result.ambientOwnerId !== result.coordinatorId
      ? `ambient owner stays ${result.ambientOwnerId}; talk to the coordinator by name`
      : undefined;
  const agents = result.agents.map(({ agentId, name, workspace, agentDir }) => ({
    agentId,
    name,
    workspace,
    agentDir,
  }));
  if (opts.json) {
    writeRuntimeJson(runtime, {
      coordinatorId: result.coordinatorId,
      agents,
      ambientOwnerId: result.ambientOwnerId,
      ...(note ? { note } : {}),
    });
    return;
  }
  runtime.log(terminalText`Created team with coordinator "${result.coordinatorId}":`);
  for (const agent of agents) {
    runtime.log(terminalText`- ${agent.agentId}: ${displayPath(agent.workspace)}`);
  }
  if (note) {
    runtime.log(terminalText`${note}`);
  }
  runtime.log(
    `Talk to the coordinator: ${formatCliCommand(terminalText`openclaw agent --agent ${result.coordinatorId} --message "Describe your task"`)}`,
  );
}
