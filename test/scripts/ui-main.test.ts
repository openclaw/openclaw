import { EventEmitter } from "node:events";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockChild = {
  emit(event: string, ...args: unknown[]): boolean;
};

const state = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  spawnSyncCalls: [] as Array<{ cmd: string; args: string[] }>,
  child: null as MockChild | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      const child = new EventEmitter();
      state.spawnCalls.push({ cmd, args });
      state.child = child;
      return child;
    }),
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      state.spawnSyncCalls.push({ cmd, args });
      return { status: 0, signal: null };
    }),
  };
});

describe("scripts/ui main", () => {
  const originalPath = process.env.PATH;
  const originalArgv = [...process.argv];
  let fakeBinDir = "";

  beforeEach(() => {
    vi.resetModules();
    state.spawnCalls = [];
    state.spawnSyncCalls = [];
    state.child = null;
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "openclaw-ui-main-"));
    writeFileSync(path.join(fakeBinDir, "pnpm"), "", "utf8");
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.argv = [...originalArgv];
  });

  it("waits for the build child process to exit before resolving", async () => {
    const { main } = await import("../../scripts/ui.js");

    const runPromise = main(["build"]);
    let settled = false;
    void runPromise.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(state.spawnCalls).toEqual([
      { cmd: expect.stringContaining("pnpm"), args: ["run", "build"] },
    ]);
    expect(settled).toBe(false);
    expect(state.child).not.toBeNull();

    state.child?.emit("exit", 0, null);

    await expect(runPromise).resolves.toBe(0);
    expect(settled).toBe(true);
  });

  it("treats a symlinked absolute script path as direct execution", async () => {
    const scriptPath = fileURLToPath(new URL("../../scripts/ui.js", import.meta.url));
    const symlinkPath = path.join(fakeBinDir, "openclaw-ui-symlink.js");
    symlinkSync(scriptPath, symlinkPath);
    process.argv = [process.execPath, symlinkPath, "build"];

    await import("../../scripts/ui.js");
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.spawnCalls).toEqual([
      { cmd: expect.stringContaining("pnpm"), args: ["run", "build"] },
    ]);
  });
});
