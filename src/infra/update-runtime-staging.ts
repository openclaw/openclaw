import { randomUUID } from "node:crypto";

const STAGING_MARKER = ".openclaw-update-";
const STAGING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

/** Allocate a sibling namespace for a Git runtime promotion and its rollback contents. */
export function gitRuntimeStagingPath(destination: string): string {
  return `${destination}${STAGING_MARKER}${randomUUID()}.tmp`;
}

/** Recognize the producer's transaction directory names, including custom virtual stores. */
export function isGitRuntimeStagingName(name: string): boolean {
  const marker = name.lastIndexOf(STAGING_MARKER);
  return marker > 0 && STAGING_ID.test(name.slice(marker + STAGING_MARKER.length));
}
