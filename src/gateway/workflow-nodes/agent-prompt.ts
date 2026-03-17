/**
 * Agent Prompt Node Handler
 *
 * Executes an AI agent prompt and returns the response
 *
 * Simple and clean - no chain handling (done by executor)
 */

import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";
import { renderTemplate } from "./types.js";

export const agentPromptHandler: WorkflowNodeHandler = {
  actionType: "agent-prompt",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config, deps } = input;
    const { cfg, cliDeps, abortSignal } = deps;

    try {
      // Render template with {{input}} replacement
      const rawPrompt = config.prompt || input.previousOutput || "Ping from Workflow";
      const prompt = renderTemplate(rawPrompt, context.currentInput, context.variables);

      // Resolve agent ID
      const agentId = config.agentId || "default";

      // Create minimal job object for cron execution
      const job: CronJob = {
        id: `workflow:${nodeId}`,
        name: label,
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC", staggerMs: 0 },
        sessionTarget: "isolated" as const,
        wakeMode: "now" as const,
        payload: { kind: "agentTurn", message: prompt },
        state: {},
        agentId,
      };

      // Execute agent turn
      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps: cliDeps,
        job,
        message: prompt,
        abortSignal,
        agentId,
        sessionKey: `workflow:${nodeId}`,
        lane: "workflow",
      });

      if (result.status === "error") {
        return {
          status: "error",
          error: result.error || "Agent execution failed",
          metadata: {
            nodeId,
            label,
            agentId,
          },
        };
      }

      const outputText = result.outputText || "";

      return {
        status: "success",
        output: outputText,
        metadata: {
          nodeId,
          label,
          agentId,
          sessionId: result.sessionId,
          outputLength: outputText.length,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "agent-prompt",
        },
      };
    }
  },
};
