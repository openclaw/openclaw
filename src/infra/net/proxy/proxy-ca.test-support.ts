import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";

export function useProxyCaFiles() {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  return (contents?: string) => {
    const dir = dirs.make("openclaw-proxy-ca-");
    const file = path.join(dir, "proxy-ca.pem");
    if (contents !== undefined) {
      writeFileSync(file, contents, "utf8");
    }
    return file;
  };
}
