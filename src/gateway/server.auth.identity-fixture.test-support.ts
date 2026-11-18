import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

export function useAuthIdentityFixture() {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  return (label: string) =>
    path.join(directories.make(`${label}-`), "client", "credentials.sqlite");
}
