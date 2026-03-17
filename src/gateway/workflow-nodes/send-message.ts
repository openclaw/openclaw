/**
 * Send Message Node Handler
 *
 * Sends a message to a channel without waiting for AI response
 *
 * Simple and clean - no chain handling (done by executor)
 */

import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { WorkflowNodeHandler, NodeInput, NodeOutput, ExecutionContext } from "./types.js";
import { renderTemplate } from "./types.js";

export const sendMessageHandler: WorkflowNodeHandler = {
  actionType: "send-message",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { nodeId, label, config } = input;

    try {
      // Render template with {{input}} replacement
      const rawBody = config.body || input.previousOutput || "Hello from workflow!";
      const body = renderTemplate(rawBody, context.currentInput, context.variables);

      // Create session key for this message
      const sessionKey = `workflow:${nodeId}`;

      // Enqueue system event
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
          channel: config.channel,
          recipientId: config.recipientId,
          accountId: config.accountId,
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
