import type { StreamFn } from "@openclaw/llm-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

type PayloadHook = NonNullable<NonNullable<Parameters<StreamFn>[2]>["onPayload"]>;

/** Settle the caller hook once, then let provider policy select the outgoing payload. */
export function wrapProviderPayloadHook(
  onPayload: PayloadHook | undefined,
  after: (payload: unknown, result: unknown, model: Parameters<PayloadHook>[1]) => unknown,
  before?: (payload: unknown, model: Parameters<PayloadHook>[1]) => void,
): PayloadHook {
  return (payload, model) => {
    before?.(payload, model);
    const result = onPayload?.(payload, model);
    return isPromiseLike(result)
      ? Promise.resolve(result).then((resolved) => after(payload, resolved, model))
      : after(payload, result, model);
  };
}

/** Wraps a stream function and lets callers mutate outgoing provider payload objects. */
export function streamWithPayloadPatch(
  underlying: StreamFn,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  patchPayload: (payload: Record<string, unknown>) => void,
): ReturnType<StreamFn> {
  const originalOnPayload = options?.onPayload;
  return underlying(model, context, {
    ...options,
    onPayload: wrapProviderPayloadHook(
      (payload) => originalOnPayload?.(payload, model),
      (payload, result) => {
        // Replacement bodies need the patch too; in-place caller overrides retain precedence.
        if (result && typeof result === "object" && result !== payload) {
          // SAFETY: the replacement is an object; patches access named request fields.
          patchPayload(result as Record<string, unknown>);
        }
        return result;
      },
      (payload) => {
        // Payload hooks receive mutable request objects before the sender uses them.
        if (payload && typeof payload === "object") {
          patchPayload(payload as Record<string, unknown>);
        }
      },
    ),
  });
}
