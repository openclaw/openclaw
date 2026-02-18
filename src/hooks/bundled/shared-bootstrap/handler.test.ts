import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";

const mockStateDir = vi.hoisted(() => ({ value: "" }));
vi.mock("../../../config/paths.js", () => ({
  get STATE_DIR() {
    return mockStateDir.value;
  },
}));

// Import after mock setup — STATE_DIR is read at call time (not module load)
import handler from "./handler.js";

function createBootstrapContext(params: {
  workspaceDir: string;
  sessionKey: string;
}): AgentBootstrapHookContext {
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: [],
    sessionKey: params.sessionKey,
  };
}

describe("shared-bootstrap hook", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(await fs.realpath(process.env.TMPDIR || "/tmp"), "openclaw-shared-bootstrap-"),
    );
    mockStateDir.value = tempDir;
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does nothing when shared directory does not exist", async () => {
    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("does nothing when shared directory is empty", async () => {
    await fs.mkdir(path.join(tempDir, "shared"), { recursive: true });
    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("does nothing when no SHARED_*.md files exist", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "RULES.md"), "no prefix", "utf-8");
    await fs.writeFile(path.join(sharedDir, "notes.txt"), "not md", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(0);
  });

  it("injects SHARED_*.md files from shared directory", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared rules", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_SOUL.md"), "shared soul", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(2);
    expect(context.bootstrapFiles[0]!.name).toBe("SHARED_RULES.md");
    expect(context.bootstrapFiles[0]!.content).toBe("shared rules");
    expect(context.bootstrapFiles[1]!.name).toBe("SHARED_SOUL.md");
    expect(context.bootstrapFiles[1]!.content).toBe("shared soul");
  });

  it("sorts files alphabetically", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_C.md"), "c", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_A.md"), "a", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SHARED_B.md"), "b", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles.map((f) => f.name)).toEqual([
      "SHARED_A.md",
      "SHARED_B.md",
      "SHARED_C.md",
    ]);
  });

  it("ignores files without SHARED_ prefix", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared", "utf-8");
    await fs.writeFile(path.join(sharedDir, "SOUL.md"), "not shared", "utf-8");
    await fs.writeFile(path.join(sharedDir, "config.json"), "{}", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0]!.name).toBe("SHARED_RULES.md");
  });

  it("throws when shared directory exists but is unreadable", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.chmod(sharedDir, 0o000);

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);

    try {
      await expect(handler(event)).rejects.toThrow();
    } finally {
      await fs.chmod(sharedDir, 0o755);
    }
  });

  it("throws when a matching file cannot be read", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    const filePath = path.join(sharedDir, "SHARED_BROKEN.md");
    await fs.writeFile(filePath, "content", "utf-8");
    await fs.chmod(filePath, 0o000);

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:main",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);

    try {
      await expect(handler(event)).rejects.toThrow();
    } finally {
      await fs.chmod(filePath, 0o644);
    }
  });

  it("shared files survive in subagent sessions", async () => {
    const sharedDir = path.join(tempDir, "shared");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "SHARED_RULES.md"), "shared rules", "utf-8");

    const context = createBootstrapContext({
      workspaceDir: tempDir,
      sessionKey: "agent:main:subagent:abc",
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles).toHaveLength(1);
    expect(context.bootstrapFiles[0]!.name).toBe("SHARED_RULES.md");
  });
});
