import {
  formatTemplateInstallOutcome,
  type TemplateInstallEvent,
} from "../../shared/template-install-notice.js";
import {
  injectGatewayAssistantMessage,
  injectGatewaySystemNotice,
  type GatewayAssistantInjectionContext,
} from "./chat-inject.js";

/** Both transports publish installer facts through the ordinary transcript owner, never a model. */
export async function publishTemplateInstallEvent(
  context: GatewayAssistantInjectionContext,
  event: TemplateInstallEvent,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const target = { agentId: event.agentId, sessionKey: event.sessionKey };
  const published =
    event.kind === "plugin-install"
      ? await injectGatewayAssistantMessage(
          context,
          {
            ...target,
            message: "",
            content: [{ ...event.plugin }],
            literal: true,
            idempotencyKey: `templates.add:${event.agentId}:plugin:${event.plugin.pluginId}:${event.plugin.status}`,
          },
          assertCurrent,
        )
      : await injectGatewaySystemNotice(
          context,
          {
            ...target,
            message: formatTemplateInstallOutcome(event),
            sourceTool: "templates_add_installer",
            idempotencyKey:
              event.kind === "automation-created"
                ? `templates.add:${event.agentId}:automation:${event.schedulerJobId}:created`
                : `templates.add:${event.agentId}:automation:${event.declarationId}:failed`,
          },
          assertCurrent,
        );
  if (!published.ok) {
    throw new Error(published.error.message);
  }
  assertCurrent();
}
