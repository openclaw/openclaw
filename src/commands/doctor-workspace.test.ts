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
    // Canonicalize like the shared temp-dir helpers do: on macOS tmpdir sits
    // behind a symlink, and the publication failure tests intercept renames by
    // comparing against the resolved destination the repair publishes to.
    tmpDir = await fs.realpath(tmpDir);
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
  function onArchive(
    before?: (source: Parameters<typeof fs.rename>[0]) => Promise<unknown>,
    after?: (...paths: Parameters<typeof fs.rename>) => Promise<unknown>,
  ) {
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementationOnce(async (source, target) => {
      await before?.(source);
      rename.mockRestore();
      await fs.rename(source, target);
      await after?.(source, target);
    });
  }
  function expectSkipped(reason: string) {
    expect(note).toHaveBeenCalledExactlyOnceWith(
      `Workspace memory root repair skipped (${reason}):\n- current: ${canonicalPath}\n- legacy: ${legacyPath}`,
      "Doctor changes",
    );
  }

  afterEach(async () => {
    vi.useRealTimers();
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

  it.each(["invalid UTF-8", "oversized"])(
    "preserves the archive when its content becomes %s after validation",
    async (failure) => {
      if (!(await seedMemory())) {
        return;
      }
      const invalid = Buffer.from([0x23, 0x20, 0xff, 0x0a]);
      const oversized = failure === "oversized";
      onArchive(
        oversized ? (source) => fs.appendFile(source, Buffer.alloc(9 * 1024 * 1024)) : undefined,
        (source, target) =>
          oversized
            ? fs.writeFile(source, "# Concurrent replacement\n")
            : fs.writeFile(target, invalid),
      );
      await repair();
      await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
      const archive = await expectArchivedLegacyMemory();
      if (!oversized) {
        await expect(fs.readFile(archive)).resolves.toEqual(invalid);
      }
      const message = String(note.mock.calls[0]?.[0]);
      for (const text of [
        oversized ? "safe read limit" : "not valid UTF-8",
        canonicalPath,
        legacyPath,
        `- preserved archive: ${archive}`,
      ]) {
        expect(message).toContain(text);
      }
      expect(message).not.toContain("Workspace memory root merged");
      if (oversized) {
        await expect(fs.readFile(legacyPath, "utf8")).resolves.toBe("# Concurrent replacement\n");
      } else {
        await expectPathMissing(legacyPath);
      }
    },
  );

  it("reads legacy content after moving it into the archive", async () => {
    if (!(await seedMemory())) {
      return;
    }

    onArchive((source) => fs.appendFile(source, "# Added before archive\n", "utf8"));

    await repair();
    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Legacy");
    expect(canonical).toContain("# Added before archive");
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
    const canonicalBackup = path.join(path.dirname(archive), "MEMORY.md.pre-merge");
    expect(note).toHaveBeenCalledExactlyOnceWith(
      `Workspace memory root merged:\n- current: ${canonicalPath}\n- backup: ${archive}\n- pre-merge backup: ${canonicalBackup}\n- merged legacy content from: ${legacyPath}\n- removed legacy file: ${legacyPath}`,
      "Doctor changes",
    );
    await expect(fs.readFile(archive, "utf8")).resolves.toBe("# Legacy 旧版 �\n");
    await expect(fs.readFile(canonicalBackup, "utf8")).resolves.toBe("# Canonical 合法 😀 �\n");
  });

  it("keeps earlier backups when repairs share a timestamp and skips an already merged workspace", async () => {
    if (!(await seedMemory())) {
      return;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
    await repair();
    const archive = await expectArchivedLegacyMemory();
    const firstMerged = await fs.readFile(canonicalPath, "utf8");

    note.mockClear();
    await repair();
    expect(note).not.toHaveBeenCalled();
    await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe(firstMerged);
    expect(await expectArchivedLegacyMemory()).toBe(archive);

    await fs.writeFile(legacyPath, "# Later legacy\n");
    await repair();

    await expect(fs.readFile(archive, "utf8")).resolves.toBe("# Legacy\n");
    await expect(
      fs.readFile(path.join(path.dirname(archive), "MEMORY.md.pre-merge"), "utf8"),
    ).resolves.toBe("# Canonical\n");
    const repairDir = path.dirname(path.dirname(archive));
    const archives = await fs.readdir(repairDir);
    expect(archives).toHaveLength(2);
    const laterArchive = archives.find((entry) => entry !== path.basename(path.dirname(archive)))!;
    await expect(
      fs.readFile(path.join(repairDir, laterArchive, "memory.md"), "utf8"),
    ).resolves.toBe("# Later legacy\n");
    await expect(
      fs.readFile(path.join(repairDir, laterArchive, "MEMORY.md.pre-merge"), "utf8"),
    ).resolves.toBe(firstMerged);
    expect(await fs.readFile(canonicalPath, "utf8")).toContain("# Later legacy\n");
  });

  it.each(["ENOSPC", "EPERM"])(
    "preserves canonical memory when publication fails with %s",
    async (errorCode) => {
      if (!(await seedMemory())) {
        return;
      }
      const realRename = fs.rename.bind(fs);
      const failure = Object.assign(new Error(`publication failed: ${errorCode}`), {
        code: errorCode,
      });
      vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        if (target === canonicalPath) {
          throw failure;
        }
        return realRename(source, target);
      });

      await repair();

      expect(note).toHaveBeenCalledTimes(1);
      const message = String(note.mock.calls[0]?.[0]);
      expect(message).toContain("Workspace memory repair could not be completed");
      // A failed publication must not tear the only durable memory file, and no
      // fallback may recreate it behind the caller's back.
      await expect(fs.readFile(canonicalPath, "utf8")).resolves.toBe("# Canonical\n");
      const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory");
      const archives = await fs.readdir(repairDir);
      await expect(
        fs.readFile(path.join(repairDir, archives[0]!, "MEMORY.md.pre-merge"), "utf8"),
      ).resolves.toBe("# Canonical\n");
      await expectPathMissing(legacyPath);
    },
  );

  it("merges through a symlinked workspace directory alias", async () => {
    if (!(await seedMemory())) {
      return;
    }
    // Configured workspace aliases are supported inputs: the repair must
    // resolve the alias for atomic publication instead of failing on the
    // symlinked parent, while still writing the same canonical file.
    const aliasDir = `${tmpDir}-alias`;
    await fs.symlink(tmpDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    try {
      await maybeRepairWorkspaceMemoryHealth({
        prompter,
        scope: { ...scope, workspaceDir: aliasDir },
      });

      const canonical = await fs.readFile(canonicalPath, "utf8");
      expect(canonical).toContain("# Canonical\n");
      expect(canonical).toContain("# Legacy\n");
      await expectPathMissing(legacyPath);
      const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory");
      const archives = await fs.readdir(repairDir);
      await expect(
        fs.readFile(path.join(repairDir, archives[0]!, "MEMORY.md.pre-merge"), "utf8"),
      ).resolves.toBe("# Canonical\n");
      await expect(fs.readFile(path.join(aliasDir, "MEMORY.md"), "utf8")).resolves.toBe(canonical);
    } finally {
      await fs.rm(aliasDir, { force: true, recursive: true });
    }
  });

  it("preserves the workspace mode across a successful merge", async () => {
    if (!(await seedMemory())) {
      return;
    }
    const { mode: modeBefore } = await fs.stat(tmpDir);
    await fs.chmod(tmpDir, 0o700);
    await fs.chmod(canonicalPath, 0o640);

    await repair();

    const canonical = await fs.readFile(canonicalPath, "utf8");
    expect(canonical).toContain("# Canonical\n");
    expect(canonical).toContain("# Legacy\n");
    if (process.platform !== "win32") {
      // Publication must never widen a private workspace.
      const { mode } = await fs.stat(tmpDir);
      expect(mode & 0o777).toBe(0o700);
      expect((await fs.stat(canonicalPath)).mode & 0o777).toBe(0o640);
    }
    await fs.chmod(tmpDir, modeBefore & 0o777);
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
