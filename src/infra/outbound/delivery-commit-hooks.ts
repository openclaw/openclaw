// Delivery commit hooks attach post-commit side effects to result objects
// without widening the public outbound result shape.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";

/** Callback attached to a delivery result and run after durable send commit. */
export type OutboundDeliveryCommitHook = () => Promise<void>;

export type OutboundDeliveryCommitHookFailure = {
  channel: OutboundDeliveryResult["channel"];
  messageId: string;
  error: string;
};

const log = createSubsystemLogger("outbound/deliver");
const outboundDeliveryCommitHooks = new WeakMap<
  OutboundDeliveryResult,
  OutboundDeliveryCommitHook[]
>();

/** Attaches an after-commit hook without changing the delivery result shape. */
export function attachOutboundDeliveryCommitHook<T extends OutboundDeliveryResult>(
  result: T,
  hook?: OutboundDeliveryCommitHook,
): T {
  if (!hook) {
    return result;
  }
  const hooks = outboundDeliveryCommitHooks.get(result) ?? [];
  hooks.push(hook);
  outboundDeliveryCommitHooks.set(result, hooks);
  return result;
}

/** Runs after-commit hooks for delivered results while isolating hook failures. */
export async function runOutboundDeliveryCommitHooks(
  results: readonly OutboundDeliveryResult[],
): Promise<OutboundDeliveryCommitHookFailure[]> {
  const failures: OutboundDeliveryCommitHookFailure[] = [];
  for (const result of results) {
    for (const hook of outboundDeliveryCommitHooks.get(result) ?? []) {
      try {
        await hook();
      } catch (err) {
        const error = formatErrorMessage(err);
        failures.push({ channel: result.channel, messageId: result.messageId, error });
        // Commit hooks are side effects after successful send; failures are
        // logged but must not turn the already-committed delivery into failure.
        log.warn("Plugin message adapter after-commit hook failed.", {
          channel: result.channel,
          messageId: result.messageId,
          error,
        });
      }
    }
  }
  return failures;
}

/** Type guard for batched outbound delivery results crossing loose boundaries. */
export function isOutboundDeliveryResultArray(value: unknown): value is OutboundDeliveryResult[] {
  return Array.isArray(value);
}
