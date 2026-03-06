import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createCanvasHostHandler } from "./server.js";

describe("canvas host state dir defaults", () => {
  it("uses OPENCLAW_STATE_DIR for the default canvas root", async () => {
    await withStateDirEnv("openclaw-canvas-state-", async ({ stateDir }) => {
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
      }
    });
  });
});
