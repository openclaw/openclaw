/**
 * JSON serialisation that never throws.
 *
 * Standard JSON.stringify() throws on:
 *  - Circular references (TypeError)
 *  - BigInt values (TypeError)
 *  - Objects with a .toJSON() that throws
 *
 * This wrapper handles the common non-serialisable types that appear in
 * openclaw's internal data structures and returns null for anything that
 * still cannot be serialised, so callers can log a fallback message instead
 * of crashing.
 *
 * Security note:
 *   The replacer intentionally serialises Error.stack.  Stack traces can
 *   contain file paths and line numbers that reveal internal structure.
 *   This function is intended for internal logging only — NEVER send its
 *   output to untrusted clients.
 */
export function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[Function]";
      }
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}
