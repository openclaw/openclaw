/** Keep the first refusal across retries without changing its thrown value. */
export function retainMutationAuthority<Args extends unknown[]>(
  assertion: (...args: Args) => unknown,
): (...args: Args) => void {
  let refusal: { error: unknown } | undefined;
  return (...args) => {
    if (refusal) {
      throw refusal.error;
    }
    try {
      const returned: unknown = assertion(...args);
      // TypeScript permits async callbacks for () => void; a promise cannot admit a mutation.
      if (
        returned !== null &&
        (typeof returned === "object" || typeof returned === "function") &&
        // SAFETY: The object/function guard permits reading then; a throwing getter stays the original refusal.
        typeof (returned as { then?: unknown }).then === "function"
      ) {
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError("mutation authority must be synchronous");
      }
    } catch (error) {
      refusal = { error };
      throw error;
    }
  };
}
