import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../../cron/agent-id.js";
import { CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE } from "../../cron/store/delivery-codec.js";
import { formatErrorMessage } from "../../infra/errors.js";

export function isCronInvalidRequestError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return (
    message === CRON_AGENT_SELECTION_REQUIRED_MESSAGE ||
    message === CRON_DELIVERY_REPAIR_REQUIRED_MESSAGE ||
    message.startsWith("unknown cron job id:") ||
    message.startsWith("cron job already exists:") ||
    message.includes("cron job id must not be blank") ||
    message.startsWith("cron bind") ||
    message.includes("cron declarationKey") ||
    message.includes("cron displayName") ||
    message.includes("cron announce delivery requires an explicit channel") ||
    message.includes("cron check script has a syntax error") ||
    message.includes("cron check script must not be empty") ||
    message.includes('cron payload.kind="none" requires a check') ||
    message.includes("cron checks can only be combined") ||
    message.includes("cron checks are disabled") ||
    message.includes("cron checks with an agent prompt require") ||
    message.includes("cron check every interval") ||
    message.includes("cron check timeoutSeconds must be") ||
    message.includes("cron check toolBudget must be") ||
    message.includes("cron job is missing sessionTarget") ||
    message.includes("invalid cron sessionTarget session id") ||
    message.startsWith('cron sessionTarget "') ||
    message.includes("has no upcoming run time and would never fire") ||
    message.includes('sessionTarget "main" is only valid for the default agent') ||
    message.includes('cron.update payload.kind="systemEvent" requires text') ||
    message.includes('cron.update payload.kind="agentTurn" requires message') ||
    message.includes("cron webhook delivery requires") ||
    message.includes("delivery.channel") ||
    message.includes("delivery.accountId") ||
    message.includes("delivery.failureDestination.channel") ||
    message.includes("failureAlert.channel") ||
    message.includes("cron completion destination webhook requires") ||
    message.includes("cron failure destination webhook requires") ||
    message.includes("cron channel delivery config is only supported") ||
    message.includes("cron delivery.failureDestination is only supported")
  );
}
