export function isWorkerDesktopString(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= 4 * 1024;
}

export function isWorkerDesktopArgs(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(isWorkerDesktopString) &&
    value.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) <= 8 * 1024
  );
}

export function isWorkerDesktopUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value) &&
    Buffer.byteLength(value) <= 63
  );
}

// ARD encodes each account field in a 64-byte NUL-terminated slot.
export function isWorkerDesktopArdPassword(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= 63
  );
}
