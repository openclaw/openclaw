import { formatErrorMessage } from "../../infra/errors.js";

export function isCronInvalidRequestError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return (
    message.startsWith("unknown cron job id:") ||
    message.includes("cron job is missing sessionTarget") ||
    message.includes("invalid cron sessionTarget session id") ||
    message.includes('main cron jobs require payload.kind="systemEvent"') ||
    message.includes('isolated/current/session cron jobs require payload.kind="agentTurn"') ||
    message.includes("has no upcoming run time and would never fire") ||
    message.includes('sessionTarget "main" is only valid for the default agent') ||
    message.includes('cron.update payload.kind="systemEvent" requires text') ||
    message.includes('cron.update payload.kind="agentTurn" requires message') ||
    message.includes("cron webhook delivery requires") ||
    message.includes("cron completion destination webhook requires") ||
    message.includes("cron failure destination webhook requires") ||
    message.includes("cron channel delivery config is only supported") ||
    message.includes("cron delivery.failureDestination is only supported")
  );
}
