// Tests for EAGAIN retry in workspace template reads (fix for #99994).
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { fileContentDiffersFromTemplate } from "./workspace.js";

const TEMPLATE = "# AGENTS\n\nDefault agent workspace.\n";

describe("fileContentDiffersFromTemplate EAGAIN retry", () => {
  let workspace: string;
  let filePath: string;

  beforeEach(async () => {
    workspace = await makeTempWorkspace();
    filePath = path.join(workspace, "AGENTS.md");
  });

  it("returns false when the file is absent (ENOENT)", async () => {
    const result = await fileContentDiffersFromTemplate(
      path.join(workspace, "nonexistent.md"),
      TEMPLATE,
    );
    expect(result).toBe(false);
  });

  it("returns false when the file matches the template", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: TEMPLATE });
    const result = await fileContentDiffersFromTemplate(filePath, TEMPLATE);
    expect(result).toBe(false);
  });

  it("returns true when the file differs from the template", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: "# Different content" });
    const result = await fileContentDiffersFromTemplate(filePath, TEMPLATE);
    expect(result).toBe(true);
  });

  it("retries on EAGAIN and succeeds once the read recovers", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: TEMPLATE });

    let calls = 0;
    const origReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (fPath, encoding?) => {
      calls++;
      if (calls < 3) {
        const err = new Error(
          "Unknown system error -11: Unknown system error -11, read",
        ) as NodeJS.ErrnoException;
        err.code = "EAGAIN";
        err.errno = -11;
        throw err;
      }
      return origReadFile(fPath, encoding);
    }) as typeof fs.readFile);

    try {
      const result = await fileContentDiffersFromTemplate(filePath, TEMPLATE);
      expect(calls).toBe(3);
      expect(result).toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("returns false after exhausting retries on persistent EAGAIN", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: TEMPLATE });

    let calls = 0;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async () => {
      calls++;
      const err = new Error(
        "Unknown system error -11: Unknown system error -11, read",
      ) as NodeJS.ErrnoException;
      err.code = "EAGAIN";
      err.errno = -11;
      throw err;
    });

    try {
      const result = await fileContentDiffersFromTemplate(filePath, TEMPLATE);
      expect(calls).toBe(3);
      expect(result).toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("retries on EINTR and succeeds once the read recovers", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: TEMPLATE });

    let calls = 0;
    const origReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation((async (fPath, encoding?) => {
      calls++;
      if (calls < 2) {
        const err = new Error("EINTR: interrupted system call") as NodeJS.ErrnoException;
        err.code = "EINTR";
        err.errno = -4;
        throw err;
      }
      return origReadFile(fPath, encoding);
    }) as typeof fs.readFile);

    try {
      const result = await fileContentDiffersFromTemplate(filePath, TEMPLATE);
      expect(calls).toBe(2);
      expect(result).toBe(false);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("propagates non-transient errors immediately", async () => {
    await writeWorkspaceFile({ dir: workspace, name: "AGENTS.md", content: TEMPLATE });

    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    try {
      await expect(fileContentDiffersFromTemplate(filePath, TEMPLATE)).rejects.toThrow("EACCES");
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
