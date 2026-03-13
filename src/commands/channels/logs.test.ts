import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { channelsLogsCommand } from "./logs.js";
import { setLoggerOverride, resetLogger } from "../../logging.js";

// Mock the channel plugins
vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: () => [
    { id: "telegram" },
    { id: "discord" },
    { id: "slack" },
  ],
}));

describe("channelsLogsCommand", () => {
  let tempDir: string;
  let mockRuntime: { log: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-logs-test-"));
    mockRuntime = {
      log: vi.fn(),
      exit: vi.fn(),
    };
  });

  afterEach(async () => {
    resetLogger();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    vi.clearAllMocks();
  });

  it("should resolve to the most recent log file when current date file does not exist", async () => {
    // Create log files for different dates (simulating Gateway running across date boundary)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0]; // YYYY-MM-DD

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const yesterdayLogFile = path.join(tempDir, `openclaw-${yesterdayStr}.log`);
    const todayLogFile = path.join(tempDir, `openclaw-${todayStr}.log`);

    // Create yesterday's log file with some content (simulating Gateway still running)
    await fs.writeFile(
      yesterdayLogFile,
      JSON.stringify({
        time: "2026-03-10T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/feishu",
        message: "Test message from yesterday",
      }) + "\n"
    );

    // Set logger to today's file (which doesn't exist yet)
    setLoggerOverride({ file: todayLogFile });

    await channelsLogsCommand({ lines: 10 }, mockRuntime);

    // Should find and read yesterday's log file
    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain(yesterdayLogFile);
    expect(output).toContain("Test message from yesterday");
  });

  it("should use current date file when it exists", async () => {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const todayLogFile = path.join(tempDir, `openclaw-${todayStr}.log`);

    // Create today's log file
    await fs.writeFile(
      todayLogFile,
      JSON.stringify({
        time: "2026-03-11T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/feishu",
        message: "Test message from today",
      }) + "\n"
    );

    setLoggerOverride({ file: todayLogFile });

    await channelsLogsCommand({ lines: 10 }, mockRuntime);

    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain(todayLogFile);
    expect(output).toContain("Test message from today");
  });

  it("should select the most recent log file by mtime when multiple exist", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];

    const yesterdayLogFile = path.join(tempDir, `openclaw-${yesterdayStr}.log`);
    const todayLogFile = path.join(tempDir, `openclaw-${todayStr}.log`);

    // Create both log files
    await fs.writeFile(
      yesterdayLogFile,
      JSON.stringify({
        time: "2026-03-10T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/feishu",
        message: "Yesterday's message",
      }) + "\n"
    );

    await fs.writeFile(
      todayLogFile,
      JSON.stringify({
        time: "2026-03-11T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/feishu",
        message: "Today's message",
      }) + "\n"
    );

    // Set logger to a non-existent future file
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const futureStr = future.toISOString().split("T")[0];
    const futureLogFile = path.join(tempDir, `openclaw-${futureStr}.log`);

    setLoggerOverride({ file: futureLogFile });

    await channelsLogsCommand({ lines: 10 }, mockRuntime);

    // Should select today's file (most recent mtime)
    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain(todayLogFile);
    expect(output).toContain("Today's message");
    expect(output).not.toContain("Yesterday's message");
  });

  it("should filter logs by channel", async () => {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const todayLogFile = path.join(tempDir, `openclaw-${todayStr}.log`);

    // Create log file with multiple channel messages
    const lines = [
      JSON.stringify({
        time: "2026-03-11T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/telegram",
        message: "Telegram message",
      }),
      JSON.stringify({
        time: "2026-03-11T12:01:00.000Z",
        level: "info",
        subsystem: "gateway/channels/discord",
        message: "Discord message",
      }),
      JSON.stringify({
        time: "2026-03-11T12:02:00.000Z",
        level: "info",
        subsystem: "gateway/channels/telegram",
        message: "Another Telegram message",
      }),
    ].join("\n") + "\n";

    await fs.writeFile(todayLogFile, lines);

    setLoggerOverride({ file: todayLogFile });

    await channelsLogsCommand({ channel: "telegram", lines: 10 }, mockRuntime);

    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("Telegram message");
    expect(output).toContain("Another Telegram message");
    expect(output).not.toContain("Discord message");
  });

  it("should return empty array when no log files exist", async () => {
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const todayLogFile = path.join(tempDir, `openclaw-${todayStr}.log`);

    setLoggerOverride({ file: todayLogFile });

    await channelsLogsCommand({ lines: 10 }, mockRuntime);

    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("No matching log lines");
  });

  it("should handle non-rolling log file paths", async () => {
    const customLogFile = path.join(tempDir, "custom.log");

    await fs.writeFile(
      customLogFile,
      JSON.stringify({
        time: "2026-03-11T12:00:00.000Z",
        level: "info",
        subsystem: "gateway/channels/feishu",
        message: "Custom log message",
      }) + "\n"
    );

    setLoggerOverride({ file: customLogFile });

    await channelsLogsCommand({ lines: 10 }, mockRuntime);

    const output = mockRuntime.log.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain(customLogFile);
    expect(output).toContain("Custom log message");
  });
});
