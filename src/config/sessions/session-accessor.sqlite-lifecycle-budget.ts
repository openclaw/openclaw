// Object-dense JSON used 77x its bytes across parsing and two clones in a 512 MiB worker.
// Reserve most of that heap for runtime, current rows, and transient normalization work.
export const SESSION_LIFECYCLE_WORKER_SELECTED_JSON_BYTES = 2 * 1024 * 1024;
const SESSION_LIFECYCLE_WORKER_INPUT_HEAP_BYTES = 32 * 1024 * 1024;

/** Decide before dispatch without constructing another serialized copy of saved prompts. */
export function isSessionLifecycleWorkerInputBounded(input: unknown): boolean {
  let remaining = SESSION_LIFECYCLE_WORKER_INPUT_HEAP_BYTES;
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      remaining -= value.length * 2;
    } else if (value && typeof value === "object") {
      if (depth > 64) {
        return false;
      }
      if (seen.has(value)) {
        return true;
      }
      seen.add(value);
      remaining -= 128;
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
        remaining -= value.buffer.byteLength;
      } else if (Array.isArray(value)) {
        remaining -= value.length * 16;
        if (remaining < 0) {
          return false;
        }
        for (const item of value) {
          if (!visit(item, depth + 1)) {
            return false;
          }
        }
      } else {
        if (
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        ) {
          return false;
        }
        for (const key in value) {
          if (!Object.hasOwn(value, key)) {
            continue;
          }
          remaining -= key.length * 2 + 32;
          if (remaining < 0 || !visit(Reflect.get(value, key), depth + 1)) {
            return false;
          }
        }
      }
    } else {
      remaining -= 8;
    }
    return remaining >= 0;
  };
  return visit(input, 0);
}
