import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createA2uiRootRealResolver,
  getA2uiRootCandidates,
  resolveA2uiRootFromCandidates,
} from "./a2ui.js";

describe("a2ui asset resolution", () => {
  it("includes dist/canvas-host/a2ui candidates when running from bundled dist entrypoint", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2ui-"));
    try {
      const distDir = path.join(tmp, "dist");
      const candidates = getA2uiRootCandidates({
        moduleDir: distDir,
        cwd: tmp,
        execPath: process.execPath,
      });

      expect(candidates).toContain(path.join(distDir, "canvas-host", "a2ui"));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("picks the first candidate with both index.html and a2ui.bundle.js", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2ui-"));
    try {
      const missing = path.join(tmp, "missing");
      const present = path.join(tmp, "present");
      await fs.mkdir(present, { recursive: true });
      await fs.writeFile(path.join(present, "index.html"), "<html></html>");
      await fs.writeFile(path.join(present, "a2ui.bundle.js"), "// bundle");

      await expect(resolveA2uiRootFromCandidates([missing, present])).resolves.toBe(present);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not permanently cache null roots (retries on the next call)", async () => {
    let calls = 0;
    const resolver = createA2uiRootRealResolver({
      resolveRoot: async () => {
        calls += 1;
        return calls === 1 ? null : "/tmp/a2ui";
      },
      realpath: async (p) => p,
    });

    await expect(resolver()).resolves.toBeNull();
    await expect(resolver()).resolves.toBe("/tmp/a2ui");
    expect(calls).toBe(2);
  });

  it("dedupes inflight resolution work", async () => {
    let calls = 0;
    let finish: ((value: string | null) => void) | null = null;
    const pending = new Promise<string | null>((resolve) => {
      finish = resolve;
    });

    const resolver = createA2uiRootRealResolver({
      resolveRoot: async () => {
        calls += 1;
        return pending;
      },
      realpath: async (p) => p,
    });

    const p1 = resolver();
    const p2 = resolver();

    // Note: resolver() is async, so each call returns a distinct Promise object,
    // but it should still dedupe the underlying resolution work.
    expect(calls).toBe(1);

    finish?.("/tmp/a2ui");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["/tmp/a2ui", "/tmp/a2ui"]);
  });
});
