export const SCRATCH_TTL_MS = 24 * 60 * 60 * 1_000;
export const SCRATCH_EXPIRED_MESSAGE = "file expired (scratch cleaned after 24 h)";

/** Display classification only; filesystem cleanup owns root admission. */
export function isWorkspaceScratchPath(value: string): boolean {
  const parts = value.replaceAll("\\", "/").split("/");
  return (
    !parts.includes("..") &&
    parts.some(
      (part, index) =>
        part === ".openclaw" && parts[index + 1] === "tmp" && Boolean(parts[index + 2]),
    )
  );
}
