import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist all mocks
const mockFindSessionFiles = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockGetDefaultRedactPatterns = vi.hoisted(() => vi.fn());
const mockNote = vi.hoisted(() => vi.fn());

vi.mock("../gateway/session-utils.fs.js", () => ({
  findSessionFiles: mockFindSessionFiles,
}));

vi.mock("../logging/redact.js", () => ({
  getDefaultRedactPatterns: mockGetDefaultRedactPatterns,
}));

vi.mock("../terminal/note.js", () => ({
  note: mockNote,
}));

// Mock node:fs module
vi.mock("node:fs", () => ({
  default: {
    promises: {
      readFile: mockReadFile,
    },
  },
}));

// Mock config/paths
vi.mock("../config/paths.js", () => ({
  resolveStateDir: vi.fn(() => "/mock/state"),
}));

import { noteSessionSecretsWarnings } from "./doctor-sessions-secrets.js";

describe("noteSessionSecretsWarnings", () => {
  beforeEach(() => {
    mockFindSessionFiles.mockClear();
    mockReadFile.mockClear();
    mockGetDefaultRedactPatterns.mockClear();
    mockNote.mockClear();

    // Default patterns that match common secrets
    mockGetDefaultRedactPatterns.mockReturnValue([
      "/xoxb-[0-9a-zA-Z-]+/g",
      "/sk-proj-[0-9a-zA-Z]+/g",
      "/ghp_[0-9a-zA-Z]+/g",
      "/AKIA[0-9A-Z]{16}/g",
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("no session files — reports 'No session files found'", async () => {
    mockFindSessionFiles.mockResolvedValue([]);

    await noteSessionSecretsWarnings();

    expect(mockNote).toHaveBeenCalledWith(
      expect.stringContaining("No session files found"),
      "Session Secrets",
    );
  });

  it("all clean — reports 'no obvious unredacted secrets detected'", async () => {
    const mockFiles = [
      "/mock/state/agents/agent1/session1.jsonl",
      "/mock/state/agents/agent2/session2.jsonl",
    ];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // All files are clean
    mockReadFile.mockResolvedValue("normal log line\nanother normal line\n");

    await noteSessionSecretsWarnings();

    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("no obvious unredacted secrets detected");
    expect(noteCall).toContain("Scanned 2 session file(s)");
  });

  it("some dirty — reports count and percentage, suggests 'sessions scrub'", async () => {
    const mockFiles = [
      "/mock/state/agents/agent1/session1.jsonl",
      "/mock/state/agents/agent2/session2.jsonl",
      "/mock/state/agents/agent3/session3.jsonl",
      "/mock/state/agents/agent4/session4.jsonl",
    ];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // 2 out of 4 have secrets
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.includes("session1") || path.includes("session3")) {
        return "slack token: xoxb-abc123456789\n";
      }
      return "normal log line\n";
    });

    await noteSessionSecretsWarnings();

    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("Found unredacted secrets in 2 of 4");
    expect(noteCall).toContain("50%"); // 2/4 = 50%
    expect(noteCall).toContain("openclaw sessions scrub");
    expect(noteCall).toContain("--dry-run");
  });

  it("large file count (>200) — samples randomly instead of scanning all", async () => {
    // Create 300 mock files
    const mockFiles = Array.from(
      { length: 300 },
      (_, i) => `/mock/state/agents/agent${i}/session.jsonl`,
    );
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // All files are clean
    mockReadFile.mockResolvedValue("normal log line\n");

    await noteSessionSecretsWarnings();

    // Should only read 200 files (random sample)
    expect(mockReadFile).toHaveBeenCalledTimes(200);

    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("Scanned 200 session file(s)");
    expect(noteCall).toContain("(random sample)");
    expect(noteCall).toContain("no obvious unredacted secrets detected");
  });

  it("large file count with secrets — reports sample size and suggests scrub", async () => {
    // Create 250 mock files
    const mockFiles = Array.from(
      { length: 250 },
      (_, i) => `/mock/state/agents/agent${i}/session.jsonl`,
    );
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // 50 out of 200 sampled have secrets (25%)
    let secretCount = 0;
    mockReadFile.mockImplementation(async () => {
      secretCount++;
      if (secretCount <= 50) {
        return "api key: sk-proj-abc123\n";
      }
      return "normal log line\n";
    });

    await noteSessionSecretsWarnings();

    // Should sample 200 files
    expect(mockReadFile).toHaveBeenCalledTimes(200);

    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("Found unredacted secrets in 50 of 200");
    expect(noteCall).toContain("(random sample)");
    expect(noteCall).toContain("25%"); // 50/200 = 25%
    expect(noteCall).toContain("openclaw sessions scrub");
  });

  it("handles read errors gracefully", async () => {
    const mockFiles = [
      "/mock/state/agents/agent1/session1.jsonl",
      "/mock/state/agents/agent2/session2.jsonl",
    ];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    // One file succeeds, one fails
    mockReadFile
      .mockResolvedValueOnce("normal log line\n")
      .mockRejectedValueOnce(new Error("Permission denied"));

    await noteSessionSecretsWarnings();

    // Should complete without throwing and warn about unreadable files
    expect(mockNote).toHaveBeenCalled();
    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("Could not read 1 session file");
    expect(noteCall).toContain("no obvious unredacted secrets detected");
  });

  it("detects multiple pattern types", async () => {
    const mockFiles = ["/mock/state/agents/agent1/session.jsonl"];
    mockFindSessionFiles.mockResolvedValue(mockFiles);

    mockReadFile.mockResolvedValue(
      "slack: xoxb-123\naws: AKIAIOSFODNN7EXAMPLE\nopenai: sk-proj-abc123\n",
    );

    await noteSessionSecretsWarnings();

    const noteCall = mockNote.mock.calls[0][0];
    expect(noteCall).toContain("Found unredacted secrets in 1 of 1");
    expect(noteCall).toContain("100%");
  });
});
