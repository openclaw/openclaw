import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Skip on Windows — symlinks work differently and the issue is Linux/macOS only
const isWindows = process.platform === "win32";

// Capture note() calls
const noteCalls: string[] = [];
vi.mock("../terminal/note.js", () => ({
  note: (msg: string) => {
    noteCalls.push(msg);
  },
}));

describe("noteStateIntegrity: symlink config permissions (#11307)", () => {
  let tempDir: string;
  let stateDir: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    if (isWindows) {
      return;
    }
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-symlink-"));
    stateDir = path.join(tempDir, ".openclaw");
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });

    // Create required subdirectories so the function doesn't warn about missing dirs
    for (const sub of ["sessions", "store", "oauth", "agents"]) {
      await fsp.mkdir(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
    }

    prevEnv.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
    prevEnv.HOME = process.env.HOME;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.HOME = tempDir;
  });

  beforeEach(() => {
    noteCalls.length = 0;
  });

  afterAll(async () => {
    if (isWindows) {
      return;
    }
    if (prevEnv.OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevEnv.OPENCLAW_STATE_DIR;
    }
    if (prevEnv.HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevEnv.HOME;
    }
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips warning when symlink target is read-only (nix store scenario)", async () => {
    if (isWindows) {
      return;
    }
    // Simulate a nix store file: world-readable AND read-only
    const readOnlyTarget = path.join(tempDir, "nix-store-config.json");
    await fsp.writeFile(readOnlyTarget, '{"gateway":{"mode":"local"}}\n', "utf-8");
    await fsp.chmod(readOnlyTarget, 0o444);

    const symlink = path.join(stateDir, "openclaw.json");
    try {
      await fsp.unlink(symlink);
    } catch {
      /* may not exist */
    }
    await fsp.symlink(readOnlyTarget, symlink);

    // Verify setup: symlink exists, target is world-readable, target is NOT writable
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect((fs.statSync(symlink).mode & 0o044) !== 0).toBe(true);

    const { noteStateIntegrity } = await import("./doctor-state-integrity.js");
    const prompter = { confirmSkipInNonInteractive: async () => false };

    await noteStateIntegrity({ gateway: { mode: "local" } }, prompter, symlink);

    const permWarning = noteCalls.find(
      (msg) => msg.includes("group/world readable") || msg.includes("Recommend chmod 600"),
    );
    expect(permWarning).toBeUndefined();

    // Restore writable so cleanup can delete it
    await fsp.chmod(readOnlyTarget, 0o644);
  });

  it("still warns when symlink target is writable and world-readable", async () => {
    if (isWindows) {
      return;
    }
    // Simulate a regular symlink to a writable world-readable file
    const writableTarget = path.join(tempDir, "writable-config.json");
    await fsp.writeFile(writableTarget, '{"gateway":{"mode":"local"}}\n', "utf-8");
    await fsp.chmod(writableTarget, 0o644);

    const symlink = path.join(stateDir, "openclaw.json");
    try {
      await fsp.unlink(symlink);
    } catch {
      /* may not exist */
    }
    await fsp.symlink(writableTarget, symlink);

    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);

    const { noteStateIntegrity } = await import("./doctor-state-integrity.js");
    const prompter = { confirmSkipInNonInteractive: async () => false };

    await noteStateIntegrity({ gateway: { mode: "local" } }, prompter, symlink);

    const permWarning = noteCalls.find(
      (msg) => msg.includes("group/world readable") || msg.includes("Recommend chmod 600"),
    );
    expect(permWarning).toBeDefined();
  });
});
