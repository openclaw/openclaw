import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  createSessionVisibilityRowChecker: vi.fn(() => ({
    check: () => ({ allowed: true }),
  })),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    createSessionVisibilityRowChecker: () => mocks.createSessionVisibilityRowChecker(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

type SearchDetails = {
  matches?: Array<{
    sessionKey?: string;
    sessionId?: string;
    label?: string;
    matches?: Array<{ line?: number; preview?: string }>;
  }>;
  searchedSessions?: number;
  skippedSessions?: number;
  skipped?: Array<{ reason?: string; count?: number }>;
};

let tmpDir = "";

function writeTranscript(name: string, text: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function sessionStorePath(): string {
  return path.join(tmpDir, "sessions.json");
}

function sessionFileName(filePath: string): string {
  return path.basename(filePath);
}

function details(result: { details?: unknown }): SearchDetails {
  return result.details as SearchDetails;
}

describe("sessions_search tool", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-search-"));
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.createSessionVisibilityRowChecker.mockReturnValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("searches visible transcript files with case-insensitive matching", async () => {
    const alphaPath = writeTranscript(
      "alpha.jsonl",
      '{"role":"user","content":"Discuss Feishu resume command"}\n',
    );
    const betaPath = writeTranscript("beta.jsonl", '{"role":"user","content":"No match here"}\n');
    mocks.gatewayCall.mockResolvedValueOnce({
      path: sessionStorePath(),
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          sessionId: "alpha",
          label: "Alpha",
          sessionFile: sessionFileName(alphaPath),
          updatedAt: 10,
        },
        {
          key: "agent:main:telegram:direct:beta",
          kind: "direct",
          sessionId: "beta",
          label: "Beta",
          sessionFile: sessionFileName(betaPath),
        },
      ],
    });
    const tool = createSessionsSearchTool({ config: {} as never });

    const result = await tool.execute("call-1", { query: "feishu" });
    const payload = details(result);

    expect(mocks.gatewayCall).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        activeMinutes: undefined,
        agentId: undefined,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: true,
        includeUnknown: true,
        label: undefined,
        limit: 200,
        search: undefined,
        spawnedBy: undefined,
      },
    });
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches?.[0]).toMatchObject({
      sessionKey: "agent:main:main",
      sessionId: "alpha",
      label: "Alpha",
    });
    expect(payload.matches?.[0]?.matches?.[0]).toMatchObject({
      line: 1,
    });
    expect(payload.matches?.[0]?.matches?.[0]?.preview).toContain("Feishu resume");
  });

  it("only reads sessions that remain after sessions_list visibility filtering", async () => {
    const visiblePath = writeTranscript("visible.jsonl", "needle in visible session\n");
    const hiddenPath = writeTranscript("hidden.jsonl", "needle in hidden session\n");
    mocks.createSessionVisibilityRowChecker.mockReturnValue({
      check: (row: { key?: string }) =>
        row.key === "agent:main:hidden"
          ? { allowed: false, reason: "not visible" }
          : { allowed: true },
    } as never);
    const readSpy = vi.spyOn(fsp, "readFile");
    mocks.gatewayCall.mockResolvedValueOnce({
      path: sessionStorePath(),
      sessions: [
        {
          key: "agent:main:visible",
          kind: "direct",
          sessionId: "visible",
          sessionFile: sessionFileName(visiblePath),
        },
        {
          key: "agent:main:hidden",
          kind: "direct",
          sessionId: "hidden",
          sessionFile: sessionFileName(hiddenPath),
        },
      ],
    });
    const tool = createSessionsSearchTool({ config: {} as never });

    const result = await tool.execute("call-2", { query: "needle" });
    const payload = details(result);

    expect(payload.matches?.map((match) => match.sessionKey)).toEqual(["agent:main:visible"]);
    expect(readSpy.mock.calls.some(([file]) => String(file) === hiddenPath)).toBe(false);
    readSpy.mockRestore();
  });

  it("applies result and per-session match limits", async () => {
    const firstPath = writeTranscript(
      "first.jsonl",
      "needle first line\nneedle second line\nneedle third line\n",
    );
    const secondPath = writeTranscript("second.jsonl", "needle another session\n");
    mocks.gatewayCall.mockResolvedValueOnce({
      path: sessionStorePath(),
      sessions: [
        {
          key: "agent:main:first",
          kind: "direct",
          sessionId: "first",
          sessionFile: sessionFileName(firstPath),
        },
        {
          key: "agent:main:second",
          kind: "direct",
          sessionId: "second",
          sessionFile: sessionFileName(secondPath),
        },
      ],
    });
    const tool = createSessionsSearchTool({ config: {} as never });

    const result = await tool.execute("call-3", {
      query: "needle",
      limit: 1,
      maxMatchesPerSession: 2,
    });
    const payload = details(result);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches?.[0]?.matches).toHaveLength(2);
  });

  it("rejects too-short queries", async () => {
    const tool = createSessionsSearchTool({ config: {} as never });

    await expect(tool.execute("call-4", { query: "x" })).rejects.toThrow(
      "query must be at least 2 characters",
    );
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });

  it("reports missing transcripts without failing the whole search", async () => {
    mocks.gatewayCall.mockResolvedValueOnce({
      path: sessionStorePath(),
      sessions: [
        {
          key: "agent:main:missing",
          kind: "direct",
          sessionId: "missing",
          sessionFile: path.join(tmpDir, "missing.jsonl"),
        },
      ],
    });
    const tool = createSessionsSearchTool({ config: {} as never });

    const result = await tool.execute("call-5", { query: "needle" });
    const payload = details(result);

    expect(payload.matches).toEqual([]);
    expect(payload.skippedSessions).toBe(1);
    expect(payload.skipped).toEqual([{ reason: "missing_transcript", count: 1 }]);
  });
});
