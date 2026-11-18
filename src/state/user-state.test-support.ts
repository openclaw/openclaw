import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db.js";
import { setUserPreferences } from "./user-preferences.test-support.js";

export function fillUserPreferences(
  options: { path: string },
  profileId: string,
  count: number,
  prefix = "key",
) {
  for (let start = 0; start < count; start += 32) {
    const entries = Object.fromEntries(
      Array.from({ length: Math.min(32, count - start) }, (_, i) => [
        `${prefix}-${start + i}`,
        true,
      ]),
    );
    expect(setUserPreferences(profileId, entries, options)).toEqual({ ok: true, value: undefined });
  }
}

/** Release readers and close each database before removing its temporary directory. */
export function useUserStateFixture(prefix: string, releaseReaders = () => {}) {
  const paths: string[] = [];
  const roots = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      releaseReaders();
      vi.restoreAllMocks();
      for (const pathname of paths.splice(0)) {
        await closeOpenClawStateDatabaseByPathAsync(pathname);
      }
      cleanup();
    });
  });
  return (filename = "openclaw.sqlite") => {
    const path = join(roots.make(prefix), filename);
    paths.push(path);
    return { path };
  };
}
