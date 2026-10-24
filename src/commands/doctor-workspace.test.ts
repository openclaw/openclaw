import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const note = vi.hoisted(() => vi.fn());
// mock-isolation: capture doctor notes without writing to the interactive terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

import {
  collectWorkspaceBackupTip,
  maybeRepairWorkspaceMemoryHealth,
  noteWorkspaceMemoryHealth,
  shouldSuggestMemorySystem,
} from "./doctor-workspace.js";

const WORKSPACE_BACKUP_TIP =
  "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended-private";

it("recognizes direct, deeply nested, and symlinked Git workspaces without duplicate tips", async () => {
  await withTestDir({ prefix: "openclaw-doctor-workspace-git-" }, async (tempDir) => {
    const repoRoot = path.join(tempDir, "repo");
    const nested = path.join(repoRoot, "agents", "direct");
    const deep = path.join(repoRoot, ...Array<string>(12).fill("nested"));
    const linked = path.join(tempDir, "linked-workspace");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(deep, { recursive: true });
    await fs.symlink(nested, linked, process.platform === "win32" ? "junction" : "dir");

    const tips = [repoRoot, nested, deep, linked].map(collectWorkspaceBackupTip);
    expect(tips).toEqual([null, null, null, null]);
    expect(collectWorkspaceBackupTip(path.parse(tempDir).root)).toBe(WORKSPACE_BACKUP_TIP);
    expect(collectWorkspaceBackupTip(path.join(tempDir, "missing"))).toBeNull();
  });
});

async function expectPathMissing(targetPath: string) {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}
async function hasDistinctRootMemoryFiles(directory: string) {
  const entries = new Set(await fs.readdir(directory));
  return entries.has("MEMORY.md") && entries.has("memory.md");
}

describe("root memory repair", () => {
  let tmpDir = "";
  let scope: Parameters<typeof noteWorkspaceMemoryHealth>[0];
  let prompter: DoctorPrompter;
  let canonicalPath: string;
  let legacyPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-root-memory-"));
    canonicalPath = path.join(tmpDir, "MEMORY.md");
    legacyPath = path.join(tmpDir, "memory.md");
    scope = { agentId: "main", workspaceDir: tmpDir, labelAgent: false };
    prompter = createDoctorPrompter({ runtime: createTestRuntime(), options: { yes: true } });
    vi.spyOn(prompter, "confirmRuntimeRepair");
    note.mockClear();
  });

  async function seedMemory(canonical: string | Buffer = "# Canonical\n", legacy = "# Legacy\n") {
    await fs.writeFile(canonicalPath, canonical);
    await fs.writeFile(legacyPath, legacy);
    return hasDistinctRootMemoryFiles(tmpDir);
  }
  const repair = () => maybeRepairWorkspaceMemoryHealth({ scope, prompter });
  function expectSkipped(reason: string) {
    expect(note).toHaveBeenCalledExactlyOnceWith(
      `Workspace memory root repair skipped (${reason}):\n- current: ${canonicalPath}\n- legacy: ${legacyPath}`,
      "Doctor changes",
    );
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function expectArchivedLegacyMemory(): Promise<string> {
    const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory");
    const archives = await fs.readdir(repairDir);
    expect(archives).toHaveLength(1);
    const archivePath = path.join(repairDir, archives[0]!, "memory.md");
    await fs.access(archivePath);
    return archivePath;
  }

  it("ignores lowercase-only root memory for automatic repair", async () => {
    await fs.writeFile(legacyPath, "# Legacy\n", "utf8");

    await noteWorkspaceMemoryHealth(scope);
    expect(note).not.toHaveBeenCalled();

    await repair();
    expect(prompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Legacy\n");
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(["memory.md"]);
    await expect(shouldSuggestMemorySystem(tmpDir)).resolves.toBe(true);
  });

  it("preserves invalid UTF-8 introduced into the legacy memory archive", async () => {
    const canonical = Buffer.from("# Canonical\n");
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
    if (!(await seedMemory(canonical))) {
      return;
    }
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (source, target) => {
      rename.mockRestore();
      await fs.rename(source, target);
      await fs.writeFile(target, invalid);
    });

    await repair();

    await expect(fs.readFile(canonicalPath)).resolves.toEqual(canonical);
    const message = String(note.mock.calls[0]?.[0]);
    for (const text of ["not valid UTF-8", canonicalPath, legacyPath]) {
      expect(message).toContain(text);
    }
    expect(message).not.toContain("Workspace memory root merged");
    await expectPathMissing(legacyPath);
    const archive = await expectArchivedLegacyMemory();
    await expect(fs.readFile(archive)).resolves.toEqual(invalid);
    expect(message).toContain(`- preserved archive: ${archive}`);
  });

  it("reads legacy content after moving it into the archive", async () => {
    if (!(await seedMemory())) {
      return;
    }

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, "# Added before archive\n", "utf8");
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
    });

    await repair();
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Legacy");
    expect(canonical).toContain("# Added before archive");
  });

  it("preserves a concurrent legacy replacement beside the archive", async () => {
    if (!(await seedMemory())) {
      return;
    }

    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (sourcePath, targetPath) => {
      await fs.appendFile(sourcePath, Buffer.alloc(9 * 1024 * 1024));
      rename.mockRestore();
      await fs.rename(sourcePath, targetPath);
      await fs.writeFile(sourcePath, "# Concurrent replacement\n", "utf8");
    });

    await repair();

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
    if (!(await seedMemory("# Canonical 合法 😀 �\n", "# Legacy 旧版 �\n"))) {
      return;
    }
    await noteWorkspaceMemoryHealth(scope);
    expect(note).toHaveBeenCalledWith(
      `Split root durable memory files detected:\n- current: ${canonicalPath} (28 bytes)\n- legacy: ${legacyPath} (20 bytes)\nOpenClaw uses MEMORY.md as the current durable memory file.\nDreaming writes durable promotions to MEMORY.md, so older facts in memory.md can be shadowed.\nRun "openclaw doctor --fix" to merge the legacy file into MEMORY.md with a backup.`,
      "Workspace memory",
    );
    note.mockClear();

    await repair();

    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledWith({
      message:
        "Merge legacy root memory.md into the current MEMORY.md and remove the shadowed file?",
      initialValue: true,
    });
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Canonical 合法 😀 �");
    expect(canonical).toContain("# Legacy 旧版 �");
    await expectPathMissing(legacyPath);
    const archive = await expectArchivedLegacyMemory();
    expect(note).toHaveBeenCalledExactlyOnceWith(
      `Workspace memory root merged:\n- current: ${canonicalPath}\n- backup: ${archive}\n- merged legacy content from: ${legacyPath}\n- removed legacy file: ${legacyPath}`,
      "Doctor changes",
    );
    await expect(fs.readFile(archive, "utf8")).resolves.toBe("# Legacy 旧版 �\n");
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

  it.each(["symlink", "oversized canonical", "oversized legacy", "archive failure"])(
    "preserves memory when repair is blocked by %s",
    async (failure) => {
      const canonical = "# Canonical\n".repeat(failure === "oversized canonical" ? 1_000_000 : 1);
      const legacy = "# Legacy\n".repeat(failure === "oversized legacy" ? 1_000_000 : 1);
      const target =
        failure === "symlink" ? path.join(tmpDir, "canonical-target.md") : canonicalPath;
      await fs.writeFile(target, canonical);
      if (failure === "symlink") {
        await fs.symlink(target, canonicalPath);
      }
      await fs.writeFile(legacyPath, legacy);
      if (!(await hasDistinctRootMemoryFiles(tmpDir))) {
        return;
      }
      if (failure === "archive failure") {
        vi.spyOn(fs, "rename").mockRejectedValueOnce(
          Object.assign(new Error("cross-device rename"), { code: "EXDEV" }),
        );
      }
      await repair();
      expectSkipped(
        failure === "symlink"
          ? "a file could not be read"
          : failure === "archive failure"
            ? "legacy memory could not be archived atomically"
            : "a file exceeded the safe read limit",
      );
      if (failure.startsWith("oversized")) {
        await expectPathMissing(path.join(tmpDir, ".openclaw-repair"));
      }
      await expect(fs.readFile(target, "utf8")).resolves.toBe(canonical);
      await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe(legacy);
    },
  );
});
