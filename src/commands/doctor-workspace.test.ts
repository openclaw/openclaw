// Doctor workspace tests cover workspace path checks, repairs, and user-facing notes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

import {
  maybeRepairWorkspaceMemoryHealth,
  noteWorkspaceMemoryHealth,
  shouldSuggestMemorySystem,
} from "./doctor-workspace.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected path to be missing: ${targetPath}`);
}

async function hasDistinctRootMemoryFiles(directory: string): Promise<boolean> {
  const entries = new Set(await fs.readdir(directory));
  return entries.has("MEMORY.md") && entries.has("memory.md");
}

describe("root memory repair", () => {
  let tmpDir = "";
  let cfg: OpenClawConfig;
  let prompter: DoctorPrompter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-root-memory-"));
    cfg = {
      agents: { defaults: { workspace: tmpDir }, entries: { main: { default: true } } },
    };
    prompter = createDoctorPrompter({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      options: { yes: true },
    });
    vi.spyOn(prompter, "confirmRuntimeRepair");
    note.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function expectArchivedLegacyMemory(): Promise<string> {
    const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory");
    const archives = await fs.readdir(repairDir);
    expect(archives).toHaveLength(1);
    const archivePath = path.join(repairDir, archives[0]!, "memory.md");
    await expect(fs.access(archivePath)).resolves.toBeUndefined();
    return archivePath;
  }

  it("ignores lowercase-only root memory for automatic repair", async () => {
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");

    await noteWorkspaceMemoryHealth(cfg);
    expect(note).not.toHaveBeenCalled();

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toBe("# Legacy\n");
    const entries = await fs.readdir(tmpDir);
    expect(entries).toContain("memory.md");
    expect(entries).not.toContain("MEMORY.md");
    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("merges true split-brain root memory files into MEMORY.md", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await noteWorkspaceMemoryHealth(cfg);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Split root durable memory files detected"),
      "Workspace memory",
    );

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    const canonical = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
    expect(canonical).toContain("# Canonical");
    expect(canonical).toContain("# Legacy");
    await expectPathMissing(path.join(tmpDir, "memory.md"));
    const archivedLegacyPath = await expectArchivedLegacyMemory();
    await expect(fs.readFile(archivedLegacyPath, "utf8")).resolves.toBe("# Legacy\n");
  });

  it("reads legacy content after moving it into the archive", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, "# Added before archive\n", "utf8");
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Legacy");
    expect(canonical).toContain("# Added before archive");
  });

  it("preserves the archive when the archived file grows past the read limit", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Workspace memory root repair skipped (a file exceeded the safe read limit):",
      ),
      "Doctor changes",
    );
    await expectPathMissing(legacyPath);
    await expectArchivedLegacyMemory();
    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
  });

  it("preserves a concurrent legacy replacement beside the archive", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
      await fs.writeFile(sourcePath, "# Concurrent replacement\n", "utf8");
    });

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Workspace memory root repair skipped (a file exceeded the safe read limit):",
      ),
      "Doctor changes",
    );
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Concurrent replacement\n");
    await expectArchivedLegacyMemory();
    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
  });

  it("warns and repairs split-brain root memory through workspace doctor helpers", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }
    await noteWorkspaceMemoryHealth(cfg);
    expect(note).toHaveBeenCalledWith(
      [
        "Split root durable memory files detected:",
        `- canonical: ${path.join(tmpDir, "MEMORY.md")} (12 bytes)`,
        `- legacy: ${path.join(tmpDir, "memory.md")} (9 bytes)`,
        "OpenClaw uses MEMORY.md as the canonical durable memory file.",
        "Dreaming writes durable promotions to MEMORY.md, so older facts in memory.md can be shadowed.",
        'Run "openclaw doctor --fix" to merge the legacy file into MEMORY.md with a backup.',
      ].join("\n"),
      "Workspace memory",
    );
    note.mockClear();

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
      message: "Merge legacy root memory.md into canonical MEMORY.md and remove the shadowed file?",
      initialValue: true,
    });
    const canonical = await fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8");
    expect(canonical).toContain("# Canonical");
    expect(canonical).toContain("# Legacy");
    await expectPathMissing(path.join(tmpDir, "memory.md"));
    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = note.mock.calls[0];
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe("Workspace memory root merged:");
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(
      `- merged legacy content from: ${path.join(tmpDir, "memory.md")}`,
    );
    expect(repairLines).toContain(`- removed legacy file: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
    const archiveLine = repairLines.find((line) => line.startsWith("- backup: "));
    expect(archiveLine).toBeDefined();
    await expect(fs.readFile(archiveLine!.slice("- backup: ".length), "utf8")).resolves.toBe(
      "# Legacy\n",
    );
  });

  it("follows a symlinked AGENTS.md while keeping its target bounded", async () => {
    const agentsTarget = path.join(tmpDir, "agents-target.md");
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    await fs.writeFile(agentsTarget, "Use MEMORY.md for durable memory.\n", "utf8");
    await fs.symlink(agentsTarget, agentsPath);

    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(false);

    await fs.writeFile(agentsTarget, "MEMORY.md\n".repeat(200_000), "utf8");
    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("does not archive or remove an oversized legacy memory file", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n".repeat(1_000_000), "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Workspace memory root repair skipped (a file exceeded the safe read limit):",
      ),
      "Doctor changes",
    );
    await expectPathMissing(path.join(tmpDir, ".openclaw-repair"));
    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "# Canonical\n",
    );
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("does not archive or remove a valid legacy memory file when canonical is oversized", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n".repeat(1_000_000), "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Workspace memory root repair skipped (a file exceeded the safe read limit):",
      ),
      "Doctor changes",
    );
    await expectPathMissing(path.join(tmpDir, ".openclaw-repair"));
    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "# Canonical\n".repeat(1_000_000),
    );
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("does not archive or remove a legacy memory file when canonical cannot be read", async () => {
    const targetFile = path.join(tmpDir, "canonical-target.md");
    await fs.writeFile(targetFile, "# Canonical\n", "utf8");
    await fs.symlink(targetFile, path.join(tmpDir, "MEMORY.md"));
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Workspace memory root repair skipped (a file could not be read):"),
      "Doctor changes",
    );
    await expectPathMissing(path.join(tmpDir, ".openclaw-repair"));
    await expect(fs.readFile(targetFile, "utf8")).resolves.toBe("# Canonical\n");
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toContain(
      "# Legacy",
    );
  });

  it("reports a skipped repair when a root memory file cannot be read", async () => {
    const targetFile = path.join(tmpDir, "canonical-target.md");
    await fs.writeFile(targetFile, "# Canonical\n", "utf8");
    await fs.symlink(targetFile, path.join(tmpDir, "MEMORY.md"));
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = note.mock.calls[0];
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe("Workspace memory root repair skipped (a file could not be read):");
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
    await expect(fs.readFile(targetFile, "utf8")).resolves.toBe("# Canonical\n");
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toBe("# Legacy\n");
  });

  it("reports a skipped repair when a root memory file is oversized", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n".repeat(1_000_000), "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }

    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    expect(note).toHaveBeenCalledTimes(1);
    const repairNote = note.mock.calls[0];
    const repairMessage = String(repairNote?.[0] ?? "");
    const repairLines = repairMessage.split("\n");
    expect(repairLines[0]).toBe(
      "Workspace memory root repair skipped (a file exceeded the safe read limit):",
    );
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "# Canonical\n",
    );
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toBe(
      "# Legacy\n".repeat(1_000_000),
    );
  });

  it("skips without mutation when legacy memory cannot be archived atomically", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("cross-device rename"), { code: "EXDEV" }));

    try {
      await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(
          "Workspace memory root repair skipped (legacy memory could not be archived atomically):",
        ),
        "Doctor changes",
      );
      await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Legacy\n");
    } finally {
      rename.mockRestore();
    }
  });

  it("reports when legacy memory cannot be archived atomically", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Canonical\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("cross-device rename"), { code: "EXDEV" }));

    try {
      await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });
    } finally {
      rename.mockRestore();
    }

    const repairNote = note.mock.calls[0];
    const repairLines = String(repairNote?.[0] ?? "").split("\n");
    expect(repairLines[0]).toBe(
      "Workspace memory root repair skipped (legacy memory could not be archived atomically):",
    );
    expect(repairLines).toContain(`- canonical: ${path.join(tmpDir, "MEMORY.md")}`);
    expect(repairLines).toContain(`- legacy: ${path.join(tmpDir, "memory.md")}`);
    expect(repairNote?.[1]).toBe("Doctor changes");
    await expect(fs.readFile(path.join(tmpDir, "MEMORY.md"), "utf8")).resolves.toBe(
      "# Canonical\n",
    );
    await expect(fs.readFile(path.join(tmpDir, "memory.md"), "utf8")).resolves.toBe("# Legacy\n");
  });

  it("reports a preserved archive when a failed repair cannot restore legacy", async () => {
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    await fs.writeFile(canonicalPath, "# Canonical\n", "utf8");
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");
    if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
      return;
    }
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });
    await maybeRepairWorkspaceMemoryHealth({ cfg, prompter });

    const repairLines = String(note.mock.calls[0]?.[0] ?? "").split("\n");
    expect(repairLines).toContainEqual(expect.stringContaining("- preserved archive: "));
  });
});
