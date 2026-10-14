import type { StreamFn } from "@openclaw/llm-core";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";

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
    onPayload: (payload) => {
      // Payload hooks receive mutable provider request objects before the underlying sender uses them.
      if (payload && typeof payload === "object") {
        patchPayload(payload as Record<string, unknown>);
      }
      const result = originalOnPayload?.(payload, model);
      // An onPayload hook may replace the request body instead of mutating the
      // received object. The sender uses that replacement, so keep the patch
      // applied to whichever object actually goes out.
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then((resolved) => {
          if (resolved && typeof resolved === "object" && resolved !== payload) {
            // SAFETY: the typeof check above narrows the resolved replacement to an object.
            patchPayload(resolved as Record<string, unknown>);
          }
          return resolved;
        });
      }
      if (result && typeof result === "object" && result !== payload) {
        // SAFETY: the typeof check above narrows the replacement to an object.
        patchPayload(result as Record<string, unknown>);
      }
      return result;
    },
  });
}
