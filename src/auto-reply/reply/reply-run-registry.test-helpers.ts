import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  replyRunRegistry,
  resolveActiveReplyOperationForSessionId,
} from "./reply-run-registry.js";

export function createTestReplyOperation(
  overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {},
) {
  return createReplyOperation({
    sessionKey: "agent:main:main",
    sessionId: "session-1",
    resetTriggered: false,
    ...overrides,
  });
}

export async function queueCurrentReplyRunMessage(
  sessionId: string,
  text: string,
  options?: Parameters<typeof beginReplyMessageInjectionTarget>[2],
) {
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const target = operation
    ? replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)
    : undefined;
  return target
    ? await queueReplyMessageInjectionTarget(target, text, options)
    : { status: "rejected" as const, reason: "injection_unavailable" as const };
}

export async function queueReplyMessageInjectionTarget(
  ...args: Parameters<typeof beginReplyMessageInjectionTarget>
) {
  return await beginReplyMessageInjectionTarget(...args).outcome;
}
