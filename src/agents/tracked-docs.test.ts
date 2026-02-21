import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  getDocAtCommit,
  getDocDiff,
  getDocHistory,
  rollbackDoc,
  TRACKED_DOC_FILENAMES,
  writeTrackedDoc,
} from "./tracked-docs.js";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tracked-docs-"));
  await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 5_000 });
  await runCommandWithTimeout(["git", "config", "user.email", "test@openclaw.local"], {
    cwd: dir,
    timeoutMs: 5_000,
  });
  await runCommandWithTimeout(["git", "config", "user.name", "Test"], {
    cwd: dir,
    timeoutMs: 5_000,
  });
  return dir;
}

async function removeTempWorkspace(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("TRACKED_DOC_FILENAMES", () => {
  it("includes core workspace docs", () => {
    expect(TRACKED_DOC_FILENAMES.has("AGENTS.md")).toBe(true);
    expect(TRACKED_DOC_FILENAMES.has("SOUL.md")).toBe(true);
    expect(TRACKED_DOC_FILENAMES.has("TOOLS.md")).toBe(true);
    expect(TRACKED_DOC_FILENAMES.has("MEMORY.md")).toBe(true);
    expect(TRACKED_DOC_FILENAMES.has("POLICY.md")).toBe(true);
  });
});

describe("writeTrackedDoc", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(dir);
  });

  it("writes the file and commits to git", async () => {
    const result = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# Hello",
      sessionKey: "test-session-1",
      agentLabel: "main",
      reason: "initial setup",
    });

    expect(result.committed).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{1,12}$/);
    expect(result.warning).toBeUndefined();

    const content = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(content).toBe("# Hello");
  });

  it("returns committed=false when content is unchanged", async () => {
    await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# Hello",
      sessionKey: "test-session-1",
      reason: "first write",
    });

    const result = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# Hello",
      sessionKey: "test-session-1",
      reason: "no-op write",
    });

    expect(result.committed).toBe(false);
  });

  it("returns warning when no git repo", async () => {
    const noGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-git-"));
    try {
      const result = await writeTrackedDoc({
        workspaceDir: noGitDir,
        filename: "AGENTS.md",
        content: "# Hello",
        sessionKey: "test-session-1",
        reason: "test",
      });

      expect(result.committed).toBe(false);
      expect(result.warning).toContain("Git repo not found");

      // File should still be written even without git.
      const content = await fs.readFile(path.join(noGitDir, "AGENTS.md"), "utf-8");
      expect(content).toBe("# Hello");
    } finally {
      await removeTempWorkspace(noGitDir);
    }
  });
});

describe("getDocHistory", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(dir);
  });

  it("returns empty array for file with no commits", async () => {
    const history = await getDocHistory({ workspaceDir: dir, filename: "AGENTS.md" });
    expect(history).toEqual([]);
  });

  it("returns commits in reverse chronological order", async () => {
    await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v1",
      sessionKey: "s1",
      reason: "first",
    });

    await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v2",
      sessionKey: "s2",
      reason: "second",
    });

    const history = await getDocHistory({ workspaceDir: dir, filename: "AGENTS.md" });
    expect(history).toHaveLength(2);
    expect(history[0]?.subject).toContain("second");
    expect(history[1]?.subject).toContain("first");
  });
});

describe("getDocAtCommit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(dir);
  });

  it("returns file content at a historical commit", async () => {
    const r1 = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# original",
      sessionKey: "s1",
      reason: "initial",
    });

    await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# updated",
      sessionKey: "s2",
      reason: "update",
    });

    const atFirst = await getDocAtCommit({
      workspaceDir: dir,
      filename: "AGENTS.md",
      sha: r1.sha!,
    });

    expect(atFirst).toBe("# original");
  });

  it("returns null for unknown sha", async () => {
    const result = await getDocAtCommit({
      workspaceDir: dir,
      filename: "AGENTS.md",
      sha: "deadbeef",
    });
    expect(result).toBeNull();
  });
});

describe("rollbackDoc", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(dir);
  });

  it("restores file to prior content and commits rollback", async () => {
    const r1 = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v1",
      sessionKey: "s1",
      reason: "initial",
    });

    await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v2",
      sessionKey: "s2",
      reason: "update",
    });

    const rollback = await rollbackDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      sha: r1.sha!,
      sessionKey: "s3",
    });

    expect(rollback.committed).toBe(true);

    const current = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(current).toBe("# v1");

    const history = await getDocHistory({ workspaceDir: dir, filename: "AGENTS.md" });
    expect(history[0]?.subject).toContain("rollback");
  });
});

describe("getDocDiff", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempWorkspace();
  });

  afterEach(async () => {
    await removeTempWorkspace(dir);
  });

  it("returns unified diff between two commits", async () => {
    const r1 = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v1\nline one\n",
      sessionKey: "s1",
      reason: "initial",
    });

    const r2 = await writeTrackedDoc({
      workspaceDir: dir,
      filename: "AGENTS.md",
      content: "# v1\nline one\nline two\n",
      sessionKey: "s2",
      reason: "add line",
    });

    const diff = await getDocDiff({
      workspaceDir: dir,
      filename: "AGENTS.md",
      fromSha: r1.sha!,
      toSha: r2.sha,
    });

    expect(diff).toContain("+line two");
  });
});
