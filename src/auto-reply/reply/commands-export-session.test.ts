import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const hoisted = await vi.hoisted(async () => {
  const { createExportCommandSessionMocks } = await import("./commands-export-test-mocks.js");
  return {
    ...createExportCommandSessionMocks(vi),
    resolveCommandsSystemPromptBundleMock: vi.fn(async () => ({
      systemPrompt: "system prompt",
      tools: [],
      skillsPrompt: "",
      bootstrapFiles: [],
      injectedFiles: [],
      sandboxRuntime: { sandboxed: false, mode: "off" },
    })),
    writeFileMock: vi.fn(
      async (_filePath: string, _data: string, _encoding?: BufferEncoding) => undefined,
    ),
    mkdirMock: vi.fn(async (_filePath: string, _options?: { recursive?: boolean }) => undefined),
    accessMock: vi.fn(async (_filePath: string) => undefined),
    pathExistsMock: vi.fn(async (_filePath: string) => true),
    hasSqliteSessionTranscriptEventsMock: vi.fn(() => false),
    exportSqliteSessionTranscriptJsonlMock: vi.fn(() => ""),
    exportHtmlTemplateContents: new Map<string, string>(),
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
  resolveSessionFilePathOptions: hoisted.resolveSessionFilePathOptionsMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  getSessionEntry: (params: { sessionKey: string }) => hoisted.sessionRowsMock()[params.sessionKey],
  listSessionEntries: () =>
    Object.entries(hoisted.sessionRowsMock()).map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
    })),
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: hoisted.resolveCommandsSystemPromptBundleMock,
}));

vi.mock("../../infra/fs-safe.js", () => ({
  pathExists: hoisted.pathExistsMock,
}));

vi.mock("../../config/sessions/transcript-store.sqlite.js", () => ({
  hasSqliteSessionTranscriptEvents: hoisted.hasSqliteSessionTranscriptEventsMock,
  exportSqliteSessionTranscriptJsonl: hoisted.exportSqliteSessionTranscriptJsonlMock,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mockedFs = {
    ...actual,
    readFileSync: vi.fn((filePath: string) => {
      for (const [suffix, contents] of hoisted.exportHtmlTemplateContents) {
        if (filePath.endsWith(suffix)) {
          return contents;
        }
      }
      if (filePath.includes("/export-html/")) {
        return actual.readFileSync(filePath, "utf8");
      }
      return "";
    }),
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mockedFsPromises = {
    ...actual,
    access: hoisted.accessMock,
    mkdir: hoisted.mkdirMock,
    writeFile: hoisted.writeFileMock,
    readFile: vi.fn(async (filePath: string, encoding?: BufferEncoding) => {
      if (filePath === "/tmp/target-store/session.jsonl") {
        return "";
      }
      for (const [suffix, contents] of hoisted.exportHtmlTemplateContents) {
        if (filePath.endsWith(suffix)) {
          return contents;
        }
      }
      return actual.readFile(filePath, encoding);
    }),
  };
  return {
    ...mockedFsPromises,
    default: mockedFsPromises,
  };
});

import { buildExportSessionReply } from "./commands-export-session.js";

function makeParams(): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      SessionKey: "agent:main:slash-session",
    },
    command: {
      commandBodyNormalized: "/export-session",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "sender-1",
      channel: "quietchat",
      surface: "quietchat",
      ownerList: [],
      rawBodyNormalized: "/export-session",
    },
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
    },
    sessionKey: "agent:target:session",
    workspaceDir: "/tmp/workspace",
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function decodeExportedSessionData(html: unknown): unknown {
  if (typeof html !== "string") {
    throw new TypeError("expected export HTML string");
  }
  const match = html.match(/<script\s+id="session-data"[^>]*>([^<]*)<\/script>/);
  if (!match?.[1]) {
    throw new Error("missing session-data script");
  }
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
}

describe("buildExportSessionReply", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveSessionFilePathMock.mockReturnValue("/tmp/target-store/session.jsonl");
    hoisted.resolveSessionFilePathOptionsMock.mockImplementation(
      (params: { agentId: string; storePath: string }) => params,
    );
    hoisted.sessionRowsMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    hoisted.resolveCommandsSystemPromptBundleMock.mockResolvedValue({
      systemPrompt: "system prompt",
      tools: [],
      skillsPrompt: "",
      bootstrapFiles: [],
      injectedFiles: [],
      sandboxRuntime: { sandboxed: false, mode: "off" },
    });
    hoisted.accessMock.mockResolvedValue(undefined);
    hoisted.pathExistsMock.mockResolvedValue(true);
    hoisted.hasSqliteSessionTranscriptEventsMock.mockReturnValue(true);
    hoisted.exportSqliteSessionTranscriptJsonlMock.mockReturnValue(
      `${JSON.stringify({ type: "session", id: "session-1" })}\n`,
    );
    hoisted.exportHtmlTemplateContents.clear();
  });

  it("resolves transcript paths from the target session agent", async () => {
    await buildExportSessionReply(makeParams());

    expect(hoisted.resolveSessionFilePathOptionsMock).toHaveBeenCalledWith({
      agentId: "target",
    });
  });

  it("reads the active command session row from the session store", async () => {
    hoisted.sessionRowsMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });

    await buildExportSessionReply({
      ...makeParams(),
    });

    expect(hoisted.sessionRowsMock).toHaveBeenCalled();
    expect(hoisted.resolveSessionFilePathOptionsMock).toHaveBeenCalledWith({
      agentId: "target",
    });
  });

  it("uses the target store entry even when the wrapper sessionEntry is missing", async () => {
    hoisted.sessionRowsMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-from-store",
        updatedAt: 2,
      },
    });

    const reply = await buildExportSessionReply({
      ...makeParams(),
      sessionEntry: undefined,
    });

    expect(reply.text).toContain("✅ Session exported!");
    expect(hoisted.resolveCommandsSystemPromptBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          sessionId: "session-from-store",
        }),
      }),
    );
  });

  it("injects scripts and session data through the real export template", async () => {
    await buildExportSessionReply(makeParams());

    const html = hoisted.writeFileMock.mock.calls[0]?.[1];
    expect(typeof html).toBe("string");
    expect(html).not.toContain("{{CSS}}");
    expect(html).not.toContain("{{JS}}");
    expect(html).not.toContain("{{SESSION_DATA}}");
    expect(html).not.toContain("{{MARKED_JS}}");
    expect(html).not.toContain("{{HIGHLIGHT_JS}}");
    expect(html).not.toContain("data-openclaw-export-placeholder");
    expect(decodeExportedSessionData(html)).toMatchObject({
      header: { type: "session", id: "session-1" },
      entries: [],
      leafId: null,
      systemPrompt: "system prompt",
      tools: [],
    });
    expect(html).toContain('const base64 = document.getElementById("session-data").textContent;');
  });

  it("exports from scoped SQLite transcript events when the JSONL file is missing", async () => {
    const { buildExportSessionReply } = await import("./commands-export-session.js");
    hoisted.pathExistsMock.mockResolvedValue(false);
    hoisted.hasSqliteSessionTranscriptEventsMock.mockReturnValue(true);
    hoisted.exportSqliteSessionTranscriptJsonlMock.mockReturnValue(
      [
        JSON.stringify({ type: "session", id: "session-1" }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          message: { role: "assistant", content: "sqlite export" },
        }),
        "",
      ].join("\n"),
    );

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("✅ Session exported!");
    expect(hoisted.exportSqliteSessionTranscriptJsonlMock).toHaveBeenCalledWith({
      agentId: "target",
      sessionFile: "/tmp/target-store/session.jsonl",
      sessionId: "session-1",
    });
    const html = hoisted.writeFileMock.mock.calls[0]?.[1];
    expect(typeof html).toBe("string");
    const sessionData = decodeExportedSessionData(html) as {
      header?: { type?: string; id?: string };
      entries?: Array<{ id?: string; message?: { content?: string } }>;
      leafId?: string;
    };
    expect(sessionData.header).toMatchObject({ type: "session", id: "session-1" });
    expect(sessionData.entries).toHaveLength(1);
    expect(sessionData.entries?.[0]?.message?.content).toBe("sqlite export");
    expect(sessionData.leafId).toBe(sessionData.entries?.[0]?.id);
  });

  it("suffixes colliding default export filenames instead of overwriting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:11:12.345Z"));
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    hoisted.writeFileMock.mockRejectedValueOnce(collision).mockResolvedValueOnce(undefined);

    const reply = await buildExportSessionReply(makeParams());

    const expectedBase = path.join(
      "/tmp/workspace",
      "openclaw-session-session--2026-05-05T10-11-12.html",
    );
    const expectedSuffix = path.join(
      "/tmp/workspace",
      "openclaw-session-session--2026-05-05T10-11-12-2.html",
    );
    expect(hoisted.writeFileMock.mock.calls[0]?.[0]).toBe(expectedBase);
    expect(hoisted.writeFileMock.mock.calls[0]?.[2]).toMatchObject({
      encoding: "utf-8",
      flag: "wx",
    });
    expect(hoisted.writeFileMock.mock.calls[1]?.[0]).toBe(expectedSuffix);
    expect(reply.text).toContain("📄 File: openclaw-session-session--2026-05-05T10-11-12-2.html");
  });

  it("preserves replacement text with dollar sequences", async () => {
    hoisted.exportHtmlTemplateContents.set(
      "template.html",
      [
        '<style data-openclaw-export-placeholder="CSS"></style>',
        '<script id="session-data" type="application/json" data-openclaw-export-placeholder="SESSION_DATA"></script>',
        '<script data-openclaw-export-placeholder="MARKED_JS"></script>',
        '<script data-openclaw-export-placeholder="HIGHLIGHT_JS"></script>',
        '<script data-openclaw-export-placeholder="JS"></script>',
      ].join(""),
    );
    hoisted.exportHtmlTemplateContents.set("template.css", "/* {{THEME_VARS}} */$&$1");
    hoisted.exportHtmlTemplateContents.set("template.js", "const marker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set("vendor/marked.min.js", "const markedMarker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set(
      "vendor/highlight.min.js",
      "const highlightMarker = '$&$1';",
    );

    await buildExportSessionReply(makeParams());

    const html = hoisted.writeFileMock.mock.calls[0]?.[1];
    expect(html).toContain("$&$1");
    expect(html).toContain("const marker = '$&$1';");
    expect(html).toContain("const markedMarker = '$&$1';");
    expect(html).toContain("const highlightMarker = '$&$1';");
  });
});
