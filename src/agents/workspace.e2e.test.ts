import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  loadWorkspaceBootstrapFiles,
  resolveDefaultAgentWorkspaceDir,
} from "./workspace.js";

describe("resolveDefaultAgentWorkspaceDir", () => {
  it("uses OPENCLAW_HOME for default workspace resolution", () => {
    const dir = resolveDefaultAgentWorkspaceDir({
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(path.join(path.resolve("/srv/openclaw-home"), ".openclaw", "workspace"));
  });
});

const WORKSPACE_STATE_PATH_SEGMENTS = [".openclaw", "workspace-state.json"] as const;

async function readOnboardingState(dir: string): Promise<{
  version: number;
  bootstrapSeededAt?: string;
  onboardingCompletedAt?: string;
}> {
  const raw = await fs.readFile(path.join(dir, ...WORKSPACE_STATE_PATH_SEGMENTS), "utf-8");
  return JSON.parse(raw) as {
    version: number;
    bootstrapSeededAt?: string;
    onboardingCompletedAt?: string;
  };
}

describe("ensureAgentWorkspace", () => {
  it("creates BOOTSTRAP.md and records a seeded marker for brand new workspaces", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    const state = await readOnboardingState(tempDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(state.onboardingCompletedAt).toBeUndefined();
  });

  it("recovers partial initialization by creating BOOTSTRAP.md when marker is missing", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_AGENTS_FILENAME, content: "existing" });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(
      fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME)),
    ).resolves.toBeUndefined();
    const state = await readOnboardingState(tempDir);
    expect(state.bootstrapSeededAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not recreate BOOTSTRAP.md after completion, even when a core file is recreated", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_IDENTITY_FILENAME, content: "custom" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom" });
    await fs.unlink(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME));
    await fs.unlink(path.join(tempDir, DEFAULT_TOOLS_FILENAME));

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(tempDir, DEFAULT_TOOLS_FILENAME))).resolves.toBeUndefined();
    const state = await readOnboardingState(tempDir);
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not re-seed BOOTSTRAP.md for legacy completed workspaces without state marker", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_IDENTITY_FILENAME, content: "custom" });
    await writeWorkspaceFile({ dir: tempDir, name: DEFAULT_USER_FILENAME, content: "custom" });

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    await expect(fs.access(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const state = await readOnboardingState(tempDir);
    expect(state.bootstrapSeededAt).toBeUndefined();
    expect(state.onboardingCompletedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("loadWorkspaceBootstrapFiles", () => {
  const getMemoryEntries = (files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>) =>
    files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

  const expectSingleMemoryEntry = (
    files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>,
    content: string,
  ) => {
    const memoryEntries = getMemoryEntries(files);
    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe(content);
  };

  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expectSingleMemoryEntry(files, "memory");
  });

  it("includes memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expectSingleMemoryEntry(files, "alt");
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    expect(getMemoryEntries(files)).toHaveLength(0);
  });
});
