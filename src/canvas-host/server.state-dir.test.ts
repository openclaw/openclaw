import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../test-helpers/state-dir-env.js";

describe("canvas host state dir defaults", () => {
  let envSnapshot: ReturnType<typeof snapshotStateDirEnv>;

  beforeEach(() => {
    envSnapshot = snapshotStateDirEnv();
  });

  afterEach(() => {
    vi.resetModules();
    restoreStateDirEnv(envSnapshot);
  });

  it("uses OPENCLAW_STATE_DIR for the default canvas root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-state-"));
    const stateDir = path.join(tempRoot, "state");
    setStateDirEnv(stateDir);
    vi.resetModules();

    const { createCanvasHostHandler } = await import("./server.js");
    const handler = await createCanvasHostHandler({
      runtime: defaultRuntime,
      allowInTests: true,
    });

    try {
      const expectedRoot = await fs.realpath(path.join(stateDir, "canvas"));
      const actualRoot = await fs.realpath(handler.rootDir);
      expect(actualRoot).toBe(expectedRoot);
      const indexPath = path.join(expectedRoot, "index.html");
      const indexContents = await fs.readFile(indexPath, "utf8");
      expect(indexContents).toContain("OpenClaw Canvas");
    } finally {
      await handler.close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
