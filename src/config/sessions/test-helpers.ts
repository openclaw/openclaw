import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

export function useTempSessionsFixture(prefix: string) {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    stateDir: () => tempDir,
  };
}
