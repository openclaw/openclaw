import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

// Hoist all mocks
const mockFindSessionFiles = vi.hoisted(() => vi.fn());
const mockResolveStateDir = vi.hoisted(() => vi.fn());
const mockRedactSensitiveText = vi.hoisted(() => vi.fn());
const mockIntro = vi.hoisted(() => vi.fn());
const mockOutro = vi.hoisted(() => vi.fn());
const mockSpinner = vi.hoisted(() => vi.fn());

vi.mock("../gateway/session-utils.fs.js", () => ({
  findSessionFiles: mockFindSessionFiles,
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: mockResolveStateDir,
}));

vi.mock("../logging/redact.js", () => ({
  redactSensitiveText: mockRedactSensitiveText,
}));

vi.mock("@clack/prompts", () => ({
  intro: mockIntro,
  outro: mockOutro,
  spinner: mockSpinner,
}));

// Mock node:fs module - define inline in factory
vi.mock("node:fs", () => {
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn();
  const mockCopyFile = vi.fn();

  return {
    default: {
      promises: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        copyFile: mockCopyFile,
      },
    },
  };
});

import fs from "node:fs";
import { sessionsScrubCommand } from "./sessions-scrub.js";

describe("sessionsScrubCommand", () => {
  let mockRuntime: RuntimeEnv;
  let mockSpinnerInstance: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let mockCopyFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Get references to the mocked functions
    mockReadFile = fs.promises.readFile as unknown as ReturnType<typeof vi.fn>;
    mockWriteFile = fs.promises.writeFile as unknown as ReturnType<typeof vi.fn>;
    mockCopyFile = fs.promises.copyFile as unknown as ReturnType<typeof vi.fn>;
    mockRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;

    mockSpinnerInstance = {
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockSpinner.mockReturnValue(mockSpinnerInstance);
    mockResolveStateDir.mockReturnValue("/mock/state");
    mockIntro.mockImplementation(() => {});
    mockOutro.mockImplementation(() => {});

    // Clear all mock call history
    mockFindSessionFiles.mockClear();
    mockReadFile.mockClear();
    mockWriteFile.mockClear();
    mockCopyFile.mockClear();
    mockRedactSensitiveText.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("finds session files across multiple agent directories", async () => {
    const mockFiles = [
      "/mock/state/agents/agent1/session1.jsonl",
      "/mock/state/agents/agent2/session2.jsonl",
      "/mock/state/agents/agent3/session3.jsonl",
    ];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // All files clean (no secrets)
    mockReadFile.mockResolvedValue("line1\nline2\nline3\n");
    mockRedactSensitiveText.mockImplementation((text: string) => text);

    await sessionsScrubCommand(mockRuntime, { dryRun: true });

    expect(mockFindSessionFiles).toHaveBeenCalledWith("/mock/state");
    expect(mockReadFile).toHaveBeenCalledTimes(3);
  });

  it("dry run reports files and counts without modifying anything", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // Mock file with secrets
    mockReadFile.mockResolvedValue("normal line\nslack token: xoxb-abc123456789\nanother line\n");
    mockRedactSensitiveText.mockImplementation((text: string) => {
      if (text.includes("xoxb-")) {
        return text.replace(/xoxb-\S+/, "[REDACTED]");
      }
      return text;
    });

    await sessionsScrubCommand(mockRuntime, { dryRun: true });

    // Should not write files
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();

    // Should report stats
    const logCalls = (mockRuntime.log as ReturnType<typeof vi.fn>).mock.calls;
    const allLogs = logCalls.map((call) => String(call[0])).join(" ");
    expect(allLogs).toContain("Files scanned: ");
    expect(allLogs).toContain("would be modified");
  });

  it("scrub redacts secrets and writes back", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // Mock file with secrets
    mockReadFile.mockResolvedValue("normal line\nslack token: xoxb-abc123456789\nanother line\n");
    mockRedactSensitiveText.mockImplementation((text: string) => {
      if (text.includes("xoxb-")) {
        return text.replace(/xoxb-\S+/, "[REDACTED]");
      }
      return text;
    });

    mockCopyFile.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await sessionsScrubCommand(mockRuntime, { dryRun: false });

    // Should create backup and write file
    expect(mockCopyFile).toHaveBeenCalledWith(
      "/mock/state/agents/agent1/session.jsonl",
      "/mock/state/agents/agent1/session.jsonl.bak",
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/mock/state/agents/agent1/session.jsonl",
      "normal line\nslack token: [REDACTED]\nanother line\n",
      "utf-8",
    );
  });

  it("backup creates .bak files by default", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    mockReadFile.mockResolvedValue("secret: xoxb-123\n");
    mockRedactSensitiveText.mockImplementation((text: string) => {
      if (text.includes("xoxb-")) {
        return "[REDACTED]";
      }
      return text;
    });

    mockCopyFile.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);

    await sessionsScrubCommand(mockRuntime, {});

    expect(mockCopyFile).toHaveBeenCalledWith(
      "/mock/state/agents/agent1/session.jsonl",
      "/mock/state/agents/agent1/session.jsonl.bak",
    );
  });

  it("no backup skips .bak when --no-backup is set", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    mockReadFile.mockResolvedValue("secret: xoxb-123\n");
    mockRedactSensitiveText.mockImplementation((text: string) => {
      if (text.includes("xoxb-")) {
        return "[REDACTED]";
      }
      return text;
    });

    mockWriteFile.mockResolvedValue(undefined);

    await sessionsScrubCommand(mockRuntime, { noBackup: true });

    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("empty directory handles no session files gracefully", async () => {
    mockFindSessionFiles.mockResolvedValue([]);

    await sessionsScrubCommand(mockRuntime, {});

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();

    const logCalls = (mockRuntime.log as ReturnType<typeof vi.fn>).mock.calls;
    const allLogs = logCalls.map((call) => String(call[0])).join(" ");
    expect(allLogs).toContain("No session files found");
  });

  it("count accuracy — a line with a secret counts as 1 line scrubbed", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // 3 lines with secrets
    mockReadFile.mockResolvedValue(
      "line1\ntoken: xoxb-abc123456789\nline3\nkey: sk-proj-abc123\nline5\npass: ghp_secret123\nline7\n",
    );
    mockRedactSensitiveText.mockImplementation((text: string) => {
      if (text.includes("xoxb-") || text.includes("sk-proj-") || text.includes("ghp_")) {
        return "[REDACTED]";
      }
      return text;
    });

    await sessionsScrubCommand(mockRuntime, { dryRun: true });

    // Should count exactly 3 lines with secrets
    const logCalls = (mockRuntime.log as ReturnType<typeof vi.fn>).mock.calls;
    const allLogs = logCalls.map((call) => String(call[0])).join(" ");
    expect(allLogs).toMatch(/Lines with secrets.*3/);
  });

  it("already clean — files with no secrets are not modified", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // Clean file
    mockReadFile.mockResolvedValue("normal line 1\nnormal line 2\nnormal line 3\n");
    mockRedactSensitiveText.mockImplementation((text: string) => text);

    await sessionsScrubCommand(mockRuntime, { dryRun: false });

    // Should not write anything
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();

    const logCalls = (mockRuntime.log as ReturnType<typeof vi.fn>).mock.calls;
    const allLogs = logCalls.map((call) => String(call[0])).join(" ");
    expect(allLogs).toMatch(/Files modified.*0/);
  });
});
