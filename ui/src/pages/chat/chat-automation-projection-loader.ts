import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAutomationsToolName } from "../../../../src/agents/tools/automations-tool-name.js";
import { getMessageDerivations } from "../../lib/chat/message-derivations.ts";

export type AutomationProjection =
  typeof import("./chat-automation-creation-projection.ts").projectAutomationCreationCards;
export async function loadAutomationProjection(): Promise<AutomationProjection> {
  return (await import("./chat-automation-creation-projection.ts")).projectAutomationCreationCards;
}

function scheduler(value: unknown) {
  const block = asOptionalRecord(value);
  const name = block?.toolName ?? block?.tool_name ?? block?.name;
  return typeof name === "string" && isAutomationsToolName(name);
}

/** Dispatch only: the deferred projector independently authenticates the call and its terminal result. */
export function hasAutomationActivity(message: unknown): boolean {
  const m = asOptionalRecord(message);
  if (!m) {
    return false;
  }
  const cached = getMessageDerivations(m);
  return (cached.automationActivity ??=
    scheduler(m) ||
    (m.customType === "openclaw.nested-tool.v1" && scheduler(m.details)) ||
    (Array.isArray(m.content) &&
      m.content.some((block) => {
        const type = asOptionalRecord(block)?.type;
        return (
          type === "automation_creation_plan" ||
          type === "automation_creation_result" ||
          scheduler(block)
        );
      })));
}
