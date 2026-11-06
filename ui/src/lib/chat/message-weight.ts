// Reconciliation replaces changed messages. One weak identity fact measures
// their serialized array wrapper; callers own separators and failure policy.
const messageWeights = new WeakMap<object, number>();

export function serializedMessageArrayWeight(message: unknown): number {
  if (message && typeof message === "object") {
    const cached = messageWeights.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const weight = JSON.stringify([message]).length;
    messageWeights.set(message, weight);
    return weight;
  }
  return JSON.stringify([message]).length;
}
