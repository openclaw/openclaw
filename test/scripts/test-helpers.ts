import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function createScriptTestHarness() {
  const tempDirs: string[] = [];

  function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function cleanupTempDir(dir: string): void {
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

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        cleanupTempDir(dir);
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTempDirAsync(prefix: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function trackTempDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  return {
    createTempDir,
    createTempDirAsync,
    trackTempDir,
  };
}
