import { isKnownTransportErrorCode } from "../shared/assistant-error-format.js";

function pathEndsWith(path: readonly string[], suffix: readonly string[]): boolean {
  if (path.length < suffix.length) {
    return false;
  }
  return suffix.every((part, index) => path[path.length - suffix.length + index] === part);
}

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
    pathEndsWith(normalizedPath, ["error", "code"]) ||
    pathEndsWith(normalizedPath, ["nodeerror", "code"]) ||
    pathEndsWith(normalizedPath, ["status", "code"]) ||
    pathEndsWith(normalizedPath, ["details", "code"]) ||
    pathEndsWith(normalizedPath, ["warnings", "code"])
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
