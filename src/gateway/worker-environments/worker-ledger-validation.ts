const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function createWorkerLedgerInputValidation(label: string) {
  return {
    required: (value: unknown, field: string): string => {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} ${field} must be a non-empty string`);
      }
      return value.trim();
    },
    integer: (value: unknown, field: string, minimum: 0 | 1 = 0): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        const kind = minimum === 0 ? "non-negative" : "positive";
        throw new Error(`${label} ${field} must be a ${kind} integer`);
      }
      return value;
    },
    requestHash: (value: unknown): string => {
      if (typeof value !== "string" || !REQUEST_HASH_PATTERN.test(value)) {
        throw new Error(`${label} request hash must be lowercase SHA-256 hex`);
      }
      return value;
    },
  };
}
