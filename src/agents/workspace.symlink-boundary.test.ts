import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

describe("workspace symlink boundary widening", () => {
  if (process.platform === "win32") {
    it.skip("symlink tests not supported on Windows", () => {});
    return;
  }

  let outsideRoot: string;
  let insideAgentDir: string;
  let sharedSoulPath: string;

  beforeAll(async () => {
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-symlink-boundary-"));

    // Ensure the test workspace root exists (HOME is redirected to a temp dir).
    await fs.mkdir(DEFAULT_AGENT_WORKSPACE_DIR, { recursive: true });

    // Create a temp agent dir inside DEFAULT_AGENT_WORKSPACE_DIR so
    // resolveWorkspaceBoundary widens the boundary to the workspace root.
    insideAgentDir = await fs.mkdtemp(
      path.join(DEFAULT_AGENT_WORKSPACE_DIR, ".test-symlink-boundary-"),
    );

    // Shared file at workspace root level for the symlink-in test.
    sharedSoulPath = path.join(DEFAULT_AGENT_WORKSPACE_DIR, ".test-shared-SOUL.md");
  });

  afterAll(async () => {
    await fs.rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(insideAgentDir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(sharedSoulPath).catch(() => {});
  });

  it("resolves symlinks from an agent dir to the workspace root", async () => {
    await fs.writeFile(sharedSoulPath, "shared soul", "utf-8");
    await fs.writeFile(path.join(insideAgentDir, DEFAULT_AGENTS_FILENAME), "agent config", "utf-8");
    await fs.symlink(sharedSoulPath, path.join(insideAgentDir, DEFAULT_SOUL_FILENAME));

    const files = await loadWorkspaceBootstrapFiles(insideAgentDir);
    const soul = files.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.missing).toBe(false);
    expect(soul?.content).toBe("shared soul");
  });

  it("rejects symlinks that escape the workspace entirely", async () => {
    const escapedFile = path.join(outsideRoot, DEFAULT_SOUL_FILENAME);
    await fs.writeFile(escapedFile, "evil soul", "utf-8");

    const agentDir = path.join(DEFAULT_AGENT_WORKSPACE_DIR, ".test-escape-agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, DEFAULT_AGENTS_FILENAME), "agents", "utf-8");
    await fs.symlink(escapedFile, path.join(agentDir, DEFAULT_SOUL_FILENAME));

    try {
      const files = await loadWorkspaceBootstrapFiles(agentDir);
      const soul = files.find((f) => f.name === DEFAULT_SOUL_FILENAME);
      expect(soul?.missing).toBe(true);
      expect(soul?.content).toBeUndefined();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("uses agent dir as boundary when it is outside the workspace root", async () => {
    const standaloneAgent = path.join(outsideRoot, "standalone-agent");
    const externalDir = path.join(outsideRoot, "external");
    await fs.mkdir(standaloneAgent, { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });

    await fs.writeFile(
      path.join(standaloneAgent, DEFAULT_AGENTS_FILENAME),
      "standalone agents",
      "utf-8",
    );
    await fs.writeFile(path.join(externalDir, DEFAULT_SOUL_FILENAME), "external soul", "utf-8");
    await fs.symlink(
      path.join(externalDir, DEFAULT_SOUL_FILENAME),
      path.join(standaloneAgent, DEFAULT_SOUL_FILENAME),
    );

    const files = await loadWorkspaceBootstrapFiles(standaloneAgent);

    const soul = files.find((f) => f.name === DEFAULT_SOUL_FILENAME);
    expect(soul?.missing).toBe(true);
    expect(soul?.content).toBeUndefined();

    const agents = files.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agents?.missing).toBe(false);
    expect(agents?.content).toBe("standalone agents");
  });
});
