import { createDefaultDeps } from "../cli/deps.js";
import { throwExpectedCliError } from "../cli/failure-output.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import { deleteGatewayAgent } from "../gateway/server-methods/agents-delete.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime as runtime, writeRuntimeJson } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

export async function agentsDetachCommand(opts: { id: string; force?: boolean; json?: boolean }) {
  const normalized = normalizeAgentIdStrict(opts.id.trim());
  if (!normalized.ok) {
    throwExpectedCliError("A valid agent id is required. Run openclaw agents list to choose one.");
  }
  const agentId = normalized.value;
  if (!opts.force) {
    if (!isTerminalInteractive()) {
      throwExpectedCliError("Non-interactive session. Re-run with --force.");
    }
    const confirmed = await createClackPrompter().confirm({
      message: `Detach agent "${agentId}" while retaining its stores and workspace?`,
      initialValue: false,
    });
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }
  const result = await runWithLocalStateOwner({
    method: "agents.detach",
    params: { agentId },
    target: agentId,
    onForeignOwner: "refuse",
    databaseEngine: "configured",
    runLocal: async (scope) =>
      withLocalGatewayRequestScope(
        { deps: createDefaultDeps(), getRuntimeConfig: () => scope.config },
        async () => {
          scope.assertCurrent();
          const context = getInProcessGatewayRequestContext();
          if (!context) {
            throw new Error("Local agent detach has no Gateway request context.");
          }
          // Reuse the journaled preserve-store owner, including pending detach recovery.
          return deleteGatewayAgent(agentId, false, context, { detach: true });
        },
      ),
  });
  if (opts.json) {
    writeRuntimeJson(runtime, { ...result, detached: true, storePreserved: true });
  } else {
    runtime.log(`Detached agent "${agentId}". Stores, history, schedules, and workspace retained.`);
  }
}
