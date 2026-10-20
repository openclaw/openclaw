import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSessionTranscriptsDetailed } from "./session-transcript-files.fs.js";

let tmpDir: string;
let sessionFile: string;
const sessionId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-")));
  sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.chmodSync(tmpDir, 0o755);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function archive(onArchiveError?: (err: unknown, sourcePath: string) => void) {
  return archiveSessionTranscriptsDetailed({
    sessionId,
    sessionFile,
    storePath: path.join(tmpDir, "store.json"),
    agentId: "main",
    reason: "reset",
    onArchiveError,
  });
}

describe("archiveSessionTranscriptsDetailed failure surface", () => {
  it("invokes onArchiveError when fs.renameSync fails and returns only successful entries", () => {
    const renameError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw renameError;
    });

    const errors: Array<{ err: unknown; sourcePath: string }> = [];
    const archived = archive((err, sourcePath) => {
      errors.push({ err, sourcePath });
    });

    renameSpy.mockRestore();

    expect(archived).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(expectDefined(errors[0], "errors[0] test invariant").err).toBe(renameError);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("archives normally when no onArchiveError is provided", () => {
    const archived = archive();

    expect(archived.length).toBe(1);
    const { archivedPath } = expectDefined(archived[0], "archived[0] test invariant");
    expect(archivedPath).toContain(".jsonl.reset.");
    expect(fs.existsSync(archivedPath)).toBe(true);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it("surfaces real chmod archive failures through onArchiveError", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    fs.chmodSync(tmpDir, 0o555);

    const errors: Array<{ code?: string; sourcePath: string }> = [];
    let archived: ReturnType<typeof archiveSessionTranscriptsDetailed> = [];
    try {
      archived = archive((err, sourcePath) => {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        errors.push({ code, sourcePath });
      });
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }

    expect(archived).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    const error = expectDefined(errors[0], "errors[0] test invariant");
    expect(error.sourcePath).toBe(sessionFile);
    expect(error.code).toMatch(/^(EACCES|EPERM)$/);
    expect(fs.existsSync(sessionFile)).toBe(true);
  });
});
