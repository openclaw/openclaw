import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function useProxyCaFiles() {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return (contents?: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-ca-"));
    dirs.push(dir);
    const file = path.join(dir, "proxy-ca.pem");
    if (contents !== undefined) {
      writeFileSync(file, contents, "utf8");
    }
    return file;
  };
}
