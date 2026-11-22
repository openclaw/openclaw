import { isKnownTransportErrorCode } from "../shared/assistant-error-format.js";

/** `objectPath` is false once an array is on the path: only object cause chains keep transport codes. */
export function shouldRedactStructuredAuthorizationCode(
  normalizedKey: string,
  path: readonly string[],
  value?: string,
  objectPath = true,
): boolean {
  // An OAuth code is one URL-safe token; text with whitespace is source, such as a Code Mode script.
  if (normalizedKey !== "code" || (value !== undefined && /\s/u.test(value))) {
    return false;
  }
  const transportCode = objectPath ? value : undefined;
  const normalizedPath = path.map((part) => part.toLowerCase());
  if (
    normalizedPath.length === 1 ||
    (normalizedPath.at(-1) === "code" &&
      ["error", "nodeerror", "status", "details", "warnings"].includes(normalizedPath.at(-2) ?? ""))
  ) {
    return false;
  }
  return !(
    transportCode !== undefined &&
    normalizedPath.length > 1 &&
    normalizedPath.slice(0, -1).every((part) => part === "cause") &&
    isKnownTransportErrorCode(transportCode)
  );
}
