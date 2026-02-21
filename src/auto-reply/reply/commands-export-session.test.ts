import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const resolveDefaultSessionStorePathMock = vi.fn();
  const resolveSessionFilePathMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const sessionManagerOpenMock = vi.fn();
  const resolveCommandsSystemPromptBundleMock = vi.fn();

  return {
    resolveDefaultSessionStorePathMock,
    resolveSessionFilePathMock,
    loadSessionStoreMock,
    sessionManagerOpenMock,
    resolveCommandsSystemPromptBundleMock,
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: hoisted.sessionManagerOpenMock,
  },
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: hoisted.resolveCommandsSystemPromptBundleMock,
}));

const { buildExportSessionReply } = await import("./commands-export-session.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

describe("buildExportSessionReply", () => {
  beforeEach(() => {
    hoisted.resolveDefaultSessionStorePathMock.mockReset();
    hoisted.resolveSessionFilePathMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.sessionManagerOpenMock.mockReset();
    hoisted.resolveCommandsSystemPromptBundleMock.mockReset();
    hoisted.resolveDefaultSessionStorePathMock.mockReturnValue("/tmp/sessions.json");
    hoisted.resolveSessionFilePathMock.mockReturnValue(process.cwd() + "/package.json");
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { sessionId: "session-1234", updatedAt: 1_700_000_000_000 },
    });
    hoisted.sessionManagerOpenMock.mockReturnValue({
      getEntries: vi.fn().mockReturnValue([{ id: "entry-1" }]),
      getHeader: vi.fn().mockReturnValue({}),
      getLeafId: vi.fn().mockReturnValue("entry-1"),
    });
    hoisted.resolveCommandsSystemPromptBundleMock.mockResolvedValue({
      systemPrompt: "system prompt body",
      tools: [{ name: "tool-a", description: "test tool" }],
    });
  });

  it("writes an export file with resolved JS payloads and session payload data", async () => {
    const params = buildCommandTestParams("/export-session", {});
    params.sessionEntry = {
      sessionId: "session-1234",
      updatedAt: 1_700_000_000_001,
    };

    const reply = await buildExportSessionReply(params);
    const replyText = reply.text;
    if (replyText === undefined) {
      throw new Error("Expected reply.text to be defined");
    }

    expect(replyText).toContain("✅ Session exported!");
    expect(hoisted.resolveCommandsSystemPromptBundleMock).toHaveBeenCalledOnce();

    const outputPathMatch = replyText.match(/📄 File: (.+)/);
    expect(outputPathMatch).toBeTruthy();
    const outputPath = outputPathMatch?.[1] ?? "";
    const absoluteOutputPath = path.isAbsolute(outputPath)
      ? outputPath
      : path.join(params.workspaceDir, outputPath);
    const html = await (await import("node:fs/promises")).readFile(absoluteOutputPath, "utf-8");
    expect(outputPath).toContain("openclaw-session-session-");
    expect(outputPath.endsWith(".html")).toBe(true);
    expect(html).not.toContain("MARKED_JS;");
    expect(html).not.toContain("HIGHLIGHT_JS;");
    expect(html).not.toContain("{{JS}}");
    expect(html).toContain('class="system-prompt-full"');
    expect(html).toContain("System Prompt");

    const sessionDataMatch = html.match(
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/,
    );
    expect(sessionDataMatch).toBeTruthy();
    const sessionData = JSON.parse(
      Buffer.from(sessionDataMatch?.[1] ?? "", "base64").toString("utf8"),
    );
    expect(sessionData).toMatchObject({
      header: {},
      entries: [{ id: "entry-1" }],
      leafId: "entry-1",
      systemPrompt: "system prompt body",
      tools: [{ name: "tool-a", description: "test tool" }],
    });

    await (await import("node:fs/promises")).unlink(absoluteOutputPath);
  });

  it("returns an error when no session is active", async () => {
    const params = buildCommandTestParams("/export-session", {});
    params.sessionEntry = undefined;

    const reply = await buildExportSessionReply(params);

    expect(reply.text).toBe("❌ No active session found.");
  });
});
