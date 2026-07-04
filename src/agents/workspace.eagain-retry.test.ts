// Regression tests for transient EAGAIN/EINTR handling in workspace bootstrap
// file reads. See https://github.com/openclaw/openclaw/issues/99994.
//
// On macOS, heartbeat-driven reads of AGENTS.md / SOUL.md / etc. can surface
// EAGAIN (or the "Unknown system error -11" form) when another process is
// swapping the file. The read must retry a few times rather than propagating
// the error, which would otherwise cause the caller to treat the workspace as
// not-yet-bootstrapped and re-seed it (clobbering user edits).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileContentDiffersFromTemplate } from "./workspace.js";

let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-eagain-retry-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("fileContentDiffersFromTemplate", () => {
  it("returns false when the file is absent (ENOENT)", async () => {
    const filePath = path.join(tempDir!, "missing.md");
    const result = await fileContentDiffersFromTemplate(filePath, "template");
    expect(result).toBe(false);
  });

  it("returns false when the file matches the template", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "template content", "utf-8");
    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(false);
  });

  it("returns true when the file differs from the template", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "user customizations", "utf-8");
    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(true);
  });

  it("retries on EAGAIN and returns true once the read succeeds", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "user customizations", "utf-8");

    let calls = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      calls += 1;
      if (calls < 3) {
        const err: NodeJS.ErrnoException = new Error("EAGAIN");
        err.code = "EAGAIN";
        err.errno = -11;
        throw err;
      }
      // 3rd call: delegate to the real fs.readFile.
      spy.mockRestore();
      return fs.readFile(...args);
    });

    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });

  it("retries on EINTR and returns false when content matches", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "template content", "utf-8");

    let calls = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      calls += 1;
      if (calls < 2) {
        const err: NodeJS.ErrnoException = new Error("EINTR");
        err.code = "EINTR";
        err.errno = -4;
        throw err;
      }
      spy.mockRestore();
      return fs.readFile(...args);
    });

    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(false);
    expect(calls).toBe(2);
  });

  it("returns false after exhausting retries on persistent EAGAIN", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "user customizations", "utf-8");

    let calls = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async () => {
      calls += 1;
      const err: NodeJS.ErrnoException = new Error("EAGAIN");
      err.code = "EAGAIN";
      err.errno = -11;
      throw err;
    });

    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(false);
    expect(calls).toBe(3);
  });

  it("retries on the macOS 'Unknown system error -11' message form", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "user customizations", "utf-8");

    let calls = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      calls += 1;
      if (calls < 2) {
        throw new Error("Unknown system error -11");
      }
      spy.mockRestore();
      return fs.readFile(...args);
    });

    const result = await fileContentDiffersFromTemplate(filePath, "template content");
    expect(result).toBe(true);
    expect(calls).toBe(2);
  });

  it("propagates non-transient errors immediately", async () => {
    const filePath = path.join(tempDir!, "AGENTS.md");
    await fs.writeFile(filePath, "user customizations", "utf-8");

    let calls = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async () => {
      calls += 1;
      const err: NodeJS.ErrnoException = new Error("EACCES");
      err.code = "EACCES";
      err.errno = -13;
      throw err;
    });

    await expect(fileContentDiffersFromTemplate(filePath, "template content")).rejects.toThrow(
      "EACCES",
    );
    expect(calls).toBe(1);
  });
});
