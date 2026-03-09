/**
 * Send Message Node Handler
 *
 * Sends a message to a channel without waiting for AI response
 *
 * TODO: Implement proper channel delivery integration
 * For now, enqueues a system event
 */

import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";
import { renderTemplate } from "./types.js";

export const sendMessageHandler: WorkflowNodeHandler = {
  actionType: "send-message",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config, previousOutput } = input;

    try {
      // Render template with {{input}} replacement
      const rawBody = config.body || previousOutput || "Hello from workflow!";
      const body = renderTemplate(rawBody, context.currentInput, context.variables);

      // Extract delivery configuration (for future use)
      const channel = config.channel;
      const recipientId = config.recipientId;
      const accountId = config.accountId;

      // Create session key for this message
      const sessionKey = `workflow:${nodeId}`;

      // Enqueue system event
      // TODO: Implement actual channel delivery
      enqueueSystemEvent(body, {
        sessionKey,
        contextKey: `workflow:${nodeId}`,
      });

      return {
        status: "success",
        output: context.currentInput, // Pass through - send-message doesn't modify output
        metadata: {
          nodeId,
          label,
          channel,
          recipientId,
          accountId,
          enqueued: true,
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          nodeId,
          label,
          actionType: "send-message",
        },
      };
    }
  },
};
