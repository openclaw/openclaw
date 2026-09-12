import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const hooks = vi.hoisted(() => [] as Array<() => void>);
vi.mock("vitest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vitest")>()),
  afterEach: (cleanup: () => void) => hooks.push(cleanup),
}));

it("cleans script fixtures in LIFO order and retains failed removals for the next hook", async () => {
  const harness = createScriptTestHarness();
  const first = harness.createTempDir("openclaw-script-cleanup-first-");
  const failed = await harness.createTempDirAsync("openclaw-script-cleanup-failed-");
  const tracked = harness.trackTempDir(path.join(first, "tracked"));
  fs.mkdirSync(tracked);
  const failure = new Error("injected script fixture removal failure");
  const rmSync = fs.rmSync.bind(fs);
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((dir, options) => {
    if (dir === failed) {
      throw failure;
    }
    rmSync(dir, options);
  });
  try {
    const [cleanup] = hooks;
    if (!cleanup) {
      throw new Error("Script harness did not register its cleanup hook");
    }
    expect(() => cleanup()).toThrow(failure);
    expect.soft(remove.mock.calls.map(([dir]) => dir)).toEqual([tracked, failed, first]);
    expect.soft(fs.existsSync(tracked)).toBe(false);
    expect.soft(fs.existsSync(first)).toBe(false);

    remove.mockRestore();
    cleanup();
    expect.soft(fs.existsSync(failed)).toBe(false);
  } finally {
    remove.mockRestore();
    rmSync(first, { recursive: true, force: true });
    rmSync(failed, { recursive: true, force: true });
  }
});
