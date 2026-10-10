import { MessageActionDeniedError } from "./message-action-denial.js";

function requiredTargetError(message: string): Error {
  return new MessageActionDeniedError(message, "message_target_missing", "message-target:required");
}

export function missingTargetError(provider: string, hint?: string): Error {
  return requiredTargetError(`Delivering to ${provider} requires target${formatTargetHint(hint)}`);
}

export function missingMessageActionTargetError(action: string): Error {
  return requiredTargetError(`Action ${action} requires a target.`);
}

export function invalidMessageActionTargetError(message: string): Error {
  return new MessageActionDeniedError(message, "message_target_invalid", "message-target:valid");
}

export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new MessageActionDeniedError(
    `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`,
    "message_target_ambiguous",
    "message-target:unique",
  );
}

export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new MessageActionDeniedError(
    `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`,
    "message_target_unknown",
    "message-target:known",
  );
}

export function reservedTargetLiteralError(provider: string, raw: string, hint?: string): Error {
  return new MessageActionDeniedError(
    `Reserved target "${raw}" for ${provider} cannot be used as a literal destination. Provide an explicit id or handle.${formatTargetHint(hint, true)}`,
    "message_target_reserved",
    "message-target:explicit",
  );
}

export function isReservedTargetLiteralError(error: Error): boolean {
  return error.message.includes("Reserved target");
}

function formatTargetHint(hint?: string, withLabel = false): string {
  const normalized = hint?.trim();
  if (!normalized) {
    return "";
  }
  return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
