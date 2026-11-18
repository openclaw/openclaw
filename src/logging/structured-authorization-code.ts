import { isKnownTransportErrorCode } from "../shared/assistant-error-format.js";

export function shouldRedactStructuredAuthorizationCode(
  normalizedKey: string,
  path: readonly string[],
  transportCode?: string,
): boolean {
  if (normalizedKey !== "code") {
    return false;
  }
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
