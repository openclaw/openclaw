import type { AutomationCreationEvent } from "../../shared/automation-creation.js";
import type {
  TemplateInstallEvent,
  TemplatePluginInstallNotice,
} from "../../shared/template-install-notice.js";
import {
  injectGatewayAssistantMessage,
  type GatewayAssistantInjectionContext,
} from "./chat-inject.js";

function installReceipt(event: TemplateInstallEvent): {
  block: AutomationCreationEvent | TemplatePluginInstallNotice;
  key: string;
} {
  // Add creates one ordinary agent per installation. Retry uses that same agent and transcript.
  const planId = `template:${event.agentId}`;
  switch (event.kind) {
    case "plugin-install":
      return { block: event.plugin, key: `plugin:${event.plugin.pluginId}:${event.plugin.status}` };
    case "automation-plan":
      return {
        block: { type: "automation_creation_plan", planId, slots: event.slots },
        key: "automation-plan",
      };
    case "automation-created":
      return {
        block: {
          type: "automation_creation_result",
          planId,
          slotId: event.declarationId,
          status: "created",
          jobId: event.schedulerJobId,
          ...(event.definition ? { definition: event.definition } : {}),
        },
        key: `automation:${event.declarationId}:created:${event.schedulerJobId}`,
      };
    default:
      return {
        block: {
          type: "automation_creation_result",
          planId,
          slotId: event.declarationId,
          status: "failed",
        },
        key: `automation:${event.declarationId}:failed`,
      };
  }
}

/** Both transports publish installer facts through the ordinary transcript owner, never a model. */
export async function publishTemplateInstallEvent(
  context: GatewayAssistantInjectionContext,
  event: TemplateInstallEvent,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const { block, key } = installReceipt(event);
  const published = await injectGatewayAssistantMessage(
    context,
    {
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      message: "",
      content: [block],
      literal: true,
      idempotencyKey: `templates.add:${event.agentId}:${key}`,
    },
    assertCurrent,
  );
  if (!published.ok) {
    throw new Error(published.error.message);
  }
  assertCurrent();
}
