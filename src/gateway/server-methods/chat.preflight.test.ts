import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  transcriptPath: "",
};

const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const compactTranscriptForPreflightMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    resolveSessionFilePath: resolveSessionFilePathMock,
    updateSessionStore: updateSessionStoreMock,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: loadSessionEntryMock,
    readSessionMessages: readSessionMessagesMock,
  };
});

vi.mock("../chat-context.js", async () => {
  const actual = await vi.importActual<typeof import("../chat-context.js")>("../chat-context.js");
  return {
    ...actual,
    compactTranscriptForPreflight: compactTranscriptForPreflightMock,
  };
});

describe("performHardLimitPreflightCompact", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-preflight-"));
    state.transcriptPath = path.join(tempDir, "sess-1.jsonl");
    fs.writeFileSync(state.transcriptPath, "{}\n", "utf-8");
    resolveSessionFilePathMock.mockImplementation(() => state.transcriptPath);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(tempDir, "sessions.json"),
      entry: {
        sessionId: "sess-1",
        sessionFile: state.transcriptPath,
        totalTokens: 180_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
      },
      canonicalKey: "agent:main:main",
    });
    readSessionMessagesMock.mockReturnValue([
      {
        role: "user",
        content: [{ type: "text", text: "old context" }],
        timestamp: Date.now(),
      },
    ]);
    compactTranscriptForPreflightMock.mockReturnValue({
      compacted: true,
      summary: { updatedAt: 123 },
      keptMessages: [],
    });
    updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      const store = {
        "agent:main:main": {
          sessionId: "sess-1",
        },
      };
      return await mutator(store);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("triggers exactly one compact when hard limit is reached", async () => {
    const { performHardLimitPreflightCompact } = await import("./chat.js");
    const guard = { attempted: false, compacted: false };

    const compacted = await performHardLimitPreflightCompact({
      sessionKey: "agent:main:main",
      agentId: "main",
      storePath: path.join(tempDir, "sessions.json"),
      entry: {
        sessionId: "sess-1",
        sessionFile: state.transcriptPath,
        totalTokens: 180_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
      },
      guard,
    });

    expect(compacted).toBe(true);
    expect(compactTranscriptForPreflightMock).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
    expect(guard).toEqual({ attempted: true, compacted: true });
  });

  it("does not run compact twice inside the same request flow", async () => {
    const { performHardLimitPreflightCompact } = await import("./chat.js");
    const guard = { attempted: false, compacted: false };

    await performHardLimitPreflightCompact({
      sessionKey: "agent:main:main",
      agentId: "main",
      storePath: path.join(tempDir, "sessions.json"),
      entry: {
        sessionId: "sess-1",
        sessionFile: state.transcriptPath,
        totalTokens: 180_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
      },
      guard,
    });
    await performHardLimitPreflightCompact({
      sessionKey: "agent:main:main",
      agentId: "main",
      storePath: path.join(tempDir, "sessions.json"),
      entry: {
        sessionId: "sess-1",
        sessionFile: state.transcriptPath,
        totalTokens: 180_000,
        totalTokensFresh: true,
        contextTokens: 200_000,
      },
      guard,
    });

    expect(compactTranscriptForPreflightMock).toHaveBeenCalledTimes(1);
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(1);
  });
});
