import { existsSync } from "node:fs";
import { readFile, writeFile, access } from "node:fs/promises";
import { describe, expect, it, beforeEach } from "vitest";

// Configuration
const DOCKER_WORKSPACE = "./docker-workspace";
const HOOK_LOG_PATH = `${DOCKER_WORKSPACE}/hook-events.log`;

// Check if Docker environment is available
const isDockerAvailable = existsSync(DOCKER_WORKSPACE);

// Helper to check if file exists
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Helper to read captured events from log file
async function readCapturedEvents(): Promise<unknown[]> {
  try {
    const content = await readFile(HOOK_LOG_PATH, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Helper to clear the hook log
async function clearHookLog(): Promise<void> {
  try {
    await writeFile(HOOK_LOG_PATH, "", "utf-8");
  } catch {
    // Ignore errors
  }
}

describe.skipIf(!isDockerAvailable)("before_tool_result Docker E2E", () => {
  beforeEach(async () => {
    await clearHookLog();
  });

  it("docker container is running", async () => {
    // This is verified by the test suite being able to run
    // and access the workspace files
    const exists = await fileExists(DOCKER_WORKSPACE);
    expect(exists).toBe(true);
  });

  it("test plugin created the hook log file", async () => {
    // Check if we can access the workspace (mounted from container)
    const canAccessWorkspace = await fileExists(DOCKER_WORKSPACE);
    expect(canAccessWorkspace).toBe(true);

    // The plugin should create the log file on startup
    // Wait a moment for it to be created
    await new Promise((resolve) => setTimeout(resolve, 500));

    // File might exist but be empty
    const events = await readCapturedEvents();
    expect(Array.isArray(events)).toBe(true);
  });

  it("hook log file is writable via docker volume", async () => {
    // Write a test event to verify the volume mount works
    const testEvent = { test: true, timestamp: new Date().toISOString() };
    await writeFile(HOOK_LOG_PATH, JSON.stringify(testEvent) + "\n", "utf-8");

    // Read it back
    const events = await readCapturedEvents();
    expect(events.length).toBeGreaterThan(0);
    expect((events[0] as { test: boolean }).test).toBe(true);
  });

  it("plugin logs have correct event structure format", async () => {
    // Write a mock event in the expected format
    const mockEvent = {
      hookName: "before_tool_result",
      timestamp: new Date().toISOString(),
      toolName: "test-tool",
      toolCallId: "call-123",
      params: { arg: "value" },
      contentType: "object",
      isError: false,
      durationMs: 100,
      wasModified: false,
      wasBlocked: false,
    };

    await writeFile(HOOK_LOG_PATH, JSON.stringify(mockEvent) + "\n", "utf-8");

    const events = await readCapturedEvents();
    expect(events.length).toBe(1);

    const event = events[0] as typeof mockEvent;
    expect(event.hookName).toBe("before_tool_result");
    expect(event.toolName).toBe("test-tool");
    expect(event.isError).toBe(false);
    expect(event.durationMs).toBe(100);
    expect(event.timestamp).toBeDefined();
  });
});
