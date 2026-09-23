import {
  linkReaderTargetKey,
  resolveLinkReaderTarget,
  type LinkReaderTarget,
} from "./link-reader-target.ts";

// Response validation loads with reader content, after eager navigation selects a target.
/** Response identity includes the reader and query; an anchor only selects within that document. */
export function linkReaderResponseMatchesTarget(target: LinkReaderTarget, value: unknown): boolean {
  const returned =
    typeof value === "string" ? resolveLinkReaderTarget(value, [target.reader]) : null;
  return returned !== null && linkReaderTargetKey(returned) === linkReaderTargetKey(target);
}

/** Profile links stay with their source service and never execute authored schemes. */
export function linkReaderAuthorHref(value: unknown, source: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value, source);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === new URL(source).origin
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
