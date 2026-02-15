import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { WorkspaceBootstrapFile } from "../../../agents/workspace.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookEvent } from "../../internal-hooks.js";
import handler from "./handler.js";

/**
 * Create a mock agent:bootstrap event
 */
function createBootstrapEvent(
  workspaceDir: string,
  cfg?: OpenClawConfig,
): AgentBootstrapHookEvent {
  const bootstrapFiles: WorkspaceBootstrapFile[] = [];
  
  return {
    type: "agent",
    action: "bootstrap",
    sessionKey: "agent:main:main",
    context: {
      workspaceDir,
      bootstrapFiles,
      cfg,
    },
    timestamp: new Date(),
    messages: [],
  };
}

describe("session-start-memory hook", () => {
  it("skips non-bootstrap events", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");

    const event: any = {
      type: "command",
      action: "new",
      sessionKey: "agent:main:main",
      context: { workspaceDir: tempDir },
      timestamp: new Date(),
      messages: [],
    };

    await handler(event);

    // Should not inject anything
    expect(event.context.bootstrapFiles).toBeUndefined();
  });

  it("loads MEMORY.md by default", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await writeWorkspaceFile(
      tempDir,
      "MEMORY.md",
      "# Long-term memory\n\nImportant context here.",
    );

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles?.[0].path).toBe("CURRENT_SESSION_MEMORY.md");
    expect(event.context.bootstrapFiles?.[0].content).toContain("## MEMORY.md");
    expect(event.context.bootstrapFiles?.[0].content).toContain("Important context here");
  });

  it("loads continuity test by default", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await writeWorkspaceFile(
      tempDir,
      "memory/continuity-test.md",
      "# Test\n\nWhat did we work on yesterday?",
    );

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles?.[0].content).toContain("## continuity-test.md");
    expect(event.context.bootstrapFiles?.[0].content).toContain("What did we work on yesterday?");
  });

  it("loads recent memory files", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const todayStr = today.toISOString().split("T")[0];
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    
    await writeWorkspaceFile(
      tempDir,
      `memory/${todayStr}-work.md`,
      "# Today's work\n\nFixed bug #123",
    );
    
    await writeWorkspaceFile(
      tempDir,
      `memory/${yesterdayStr}-planning.md`,
      "# Planning\n\nFeature design",
    );

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(1);
    const content = event.context.bootstrapFiles?.[0].content || "";
    expect(content).toContain("## Recent Memory");
    expect(content).toContain("Fixed bug #123");
    expect(content).toContain("Feature design");
  });

  it("respects recentDays config", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    
    const todayStr = today.toISOString().split("T")[0];
    const oldStr = threeDaysAgo.toISOString().split("T")[0];
    
    await writeWorkspaceFile(
      tempDir,
      `memory/${todayStr}.md`,
      "Recent work",
    );
    
    await writeWorkspaceFile(
      tempDir,
      `memory/${oldStr}.md`,
      "Old work",
    );

    const cfg: Partial<OpenClawConfig> = {
      hooks: {
        internal: {
          entries: {
            "session-start-memory": {
              enabled: true,
              recentDays: 1, // Only load last 1 day
            },
          },
        },
      },
    };

    const event = createBootstrapEvent(tempDir, cfg as OpenClawConfig);
    await handler(event);

    const content = event.context.bootstrapFiles?.[0].content || "";
    expect(content).toContain("Recent work");
    expect(content).not.toContain("Old work");
  });

  it("respects custom paths config", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await writeWorkspaceFile(
      tempDir,
      "CUSTOM.md",
      "Custom context",
    );

    const cfg: Partial<OpenClawConfig> = {
      hooks: {
        internal: {
          entries: {
            "session-start-memory": {
              enabled: true,
              paths: ["CUSTOM.md"],
            },
          },
        },
      },
    };

    const event = createBootstrapEvent(tempDir, cfg as OpenClawConfig);
    await handler(event);

    const content = event.context.bootstrapFiles?.[0].content || "";
    expect(content).toContain("## CUSTOM.md");
    expect(content).toContain("Custom context");
    expect(content).not.toContain("MEMORY.md");
  });

  it("handles missing files gracefully", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    // Should not crash, just not inject anything
    expect(event.context.bootstrapFiles).toHaveLength(0);
  });

  it("handles missing workspace dir", async () => {
    const event: any = {
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:main:main",
      context: {},
      timestamp: new Date(),
      messages: [],
    };

    await handler(event);

    // Should not crash
    expect(event.context.bootstrapFiles).toBeUndefined();
  });

  it("respects enabled=false flag", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await writeWorkspaceFile(tempDir, "MEMORY.md", "Test content");

    const cfg: Partial<OpenClawConfig> = {
      hooks: {
        internal: {
          entries: {
            "session-start-memory": {
              enabled: false,
            },
          },
        },
      },
    };

    const event = createBootstrapEvent(tempDir, cfg as OpenClawConfig);
    await handler(event);

    // Should not inject anything when disabled
    expect(event.context.bootstrapFiles).toHaveLength(0);
  });

  it("rejects path traversal attempts", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    // Create a file outside workspace
    const parentDir = path.dirname(tempDir);
    const secretPath = path.join(parentDir, "secret.txt");
    await fs.writeFile(secretPath, "secret data");

    const cfg: Partial<OpenClawConfig> = {
      hooks: {
        internal: {
          entries: {
            "session-start-memory": {
              enabled: true,
              paths: ["../secret.txt"],
            },
          },
        },
      },
    };

    const event = createBootstrapEvent(tempDir, cfg as OpenClawConfig);
    await handler(event);

    // Should not inject the secret file
    expect(event.context.bootstrapFiles).toHaveLength(0);
    
    // Cleanup
    await fs.unlink(secretPath);
  });

  it("rejects absolute paths", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    const cfg: Partial<OpenClawConfig> = {
      hooks: {
        internal: {
          entries: {
            "session-start-memory": {
              enabled: true,
              paths: ["/etc/passwd"],
            },
          },
        },
      },
    };

    const event = createBootstrapEvent(tempDir, cfg as OpenClawConfig);
    await handler(event);

    // Should not inject absolute paths
    expect(event.context.bootstrapFiles).toHaveLength(0);
  });

  it("sorts recent files newest-first", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    
    await writeWorkspaceFile(tempDir, "memory/2026-02-05.md", "Day 1");
    await writeWorkspaceFile(tempDir, "memory/2026-02-06.md", "Day 2");
    await writeWorkspaceFile(tempDir, "memory/2026-02-04.md", "Day 0");

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    const content = event.context.bootstrapFiles?.[0].content || "";
    const day2Pos = content.indexOf("Day 2");
    const day1Pos = content.indexOf("Day 1");
    const day0Pos = content.indexOf("Day 0");

    expect(day2Pos).toBeLessThan(day1Pos);
    expect(day1Pos).toBeLessThan(day0Pos);
  });

  it("includes timestamp in output", async () => {
    const tempDir = await makeTempWorkspace("openclaw-session-start-");
    
    await writeWorkspaceFile(tempDir, "MEMORY.md", "Test");

    const event = createBootstrapEvent(tempDir);
    await handler(event);

    const content = event.context.bootstrapFiles?.[0].content || "";
    expect(content).toMatch(/Auto-generated at \d{4}-\d{2}-\d{2}T/);
  });
});
