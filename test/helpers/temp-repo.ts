import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempRepoRoot(tempDirs: string[], prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function cleanupTempDirs(tempDirs: string[]): void {
  for (const dir of tempDirs.splice(0)) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        sleepSync(100);
      }
    }
    if (lastError) {
      throw lastError;
    }
  }
}
