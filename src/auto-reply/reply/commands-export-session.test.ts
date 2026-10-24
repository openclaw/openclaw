// Tests session and trajectory export command packaging, filesystem writes, and approval routing.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateExportHtmlVendorAssets } from "../../../scripts/runtime-postbuild.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { projectPluginInlineView } from "../../gateway/chat-display-projection.inline-view.js";
import {
  createPluginInlineViewResult,
  bindPluginInlineViewInvocation,
} from "../../plugins/inline-view.js";
import { buildCommandTextFromArgs, findCommandByNativeName } from "../commands-registry.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";

const hoisted = await vi.hoisted(async () => {
  const { createExportCommandSessionMocks } = await import("./commands-export-test-mocks.js");
  const promptBundle = {
    systemPrompt: "system prompt",
    tools: [],
  };
  return {
    ...createExportCommandSessionMocks(vi),
    promptBundle,
    resolveCommandsSystemPromptBundleMock: vi.fn(async () => promptBundle),
    migrateSessionEntriesMock: vi.fn((_entries: unknown[]) => undefined),
    readAcpSessionMetaForEntryAsyncMock: vi.fn<
      (params: { sessionKey: string; entry?: { sessionId?: string } }) => Promise<unknown>
    >(async () => undefined),
    loadTranscriptEventsMock: vi.fn(async (): Promise<unknown[]> => []),
    exportHtmlTemplateContents: new Map<string, string>(),
    sessionTranscriptEvents: [] as unknown[],
  };
});
const generatedVendorAssets = generateExportHtmlVendorAssets();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// mock-isolation: Export fixtures supply ACP metadata without opening a real session database.
vi.mock("../../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntryAsync: hoisted.readAcpSessionMetaForEntryAsyncMock,
}));

vi.mock("../../config/sessions/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/paths.js")>()),
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
}));

vi.mock("../../config/sessions/session-accessor.js", () => {
  const loadSessionEntry = (scope: { storePath?: string; sessionKey: string }) =>
    (hoisted.loadSessionStoreMock(scope.storePath) as Record<string, unknown>)[scope.sessionKey];
  return {
    loadSessionEntry,
    loadSessionEntryReadOnly: loadSessionEntry,
    loadTranscriptEvents: hoisted.loadTranscriptEventsMock,
  };
});

// mock-isolation: Export orchestration reads fixture-owned session rows without opening a store.
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { storePath?: string; sessionKey: string }) =>
    (hoisted.loadSessionStoreMock(scope.storePath) as Record<string, unknown>)[scope.sessionKey],
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: hoisted.resolveCommandsSystemPromptBundleMock,
}));

vi.mock("../../agents/sessions/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/sessions/session-manager.js")>();
  return {
    ...actual,
    migrateSessionEntries: hoisted.migrateSessionEntriesMock,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mockedFsPromises = {
    ...actual,
    readFile: vi.fn(async (filePath: string, encoding?: BufferEncoding) => {
      for (const [suffix, contents] of hoisted.exportHtmlTemplateContents) {
        if (filePath.endsWith(suffix)) {
          return contents;
        }
      }
      return actual.readFile(filePath, { encoding });
    }),
  };
  return {
    ...mockedFsPromises,
    default: mockedFsPromises,
  };
});

function makeParams(workspaceDir = tempDirs.make("openclaw-session-export-")) {
  return commandFixture("/export-session session.html", {
    workspaceDir,
    ctx: { SessionKey: "agent:main:slash-session" },
  });
}

async function writtenHtml(params: { workspaceDir: string }): Promise<string> {
  return await fs.readFile(path.join(params.workspaceDir, "session.html"), "utf-8");
}

function sessionDataFromHtml(html: string): Record<string, unknown> {
  const match = html.match(/id="session-data"[^>]*>([^<]+)</);
  if (!match) {
    throw new Error("Expected session-data script in exported HTML");
  }
  return JSON.parse(
    Buffer.from(expectDefined(match[1], "match[1] test invariant").trim(), "base64").toString(
      "utf-8",
    ),
  );
}

function messageEntry(id: string, message: { role?: string; content: string }, seconds = 0) {
  return {
    type: "message",
    id,
    timestamp: new Date(Date.UTC(2026, 4, 16, 0, 0, seconds)).toISOString(),
    message,
  };
}

const userTranscript = () => [messageEntry("entry-1", { role: "user", content: "hello" })];
const acpMetadata = {
  backend: "acpx",
  mode: "persistent",
  agent: "claude",
  runtimeSessionName: "backend-session-1",
  state: "idle",
  lastActivityAt: 1,
} as const;

describe("buildExportSessionReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveDefaultSessionStorePathMock.mockReturnValue("/tmp/target-store/sessions.json");
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    hoisted.resolveCommandsSystemPromptBundleMock.mockResolvedValue(hoisted.promptBundle);
    hoisted.readAcpSessionMetaForEntryAsyncMock.mockResolvedValue(undefined);
    hoisted.loadTranscriptEventsMock.mockImplementation(
      async () => hoisted.sessionTranscriptEvents,
    );
    hoisted.exportHtmlTemplateContents.clear();
    for (const [fileName, contents] of Object.entries(generatedVendorAssets)) {
      hoisted.exportHtmlTemplateContents.set(`vendor/${fileName}`, contents);
    }
    hoisted.sessionTranscriptEvents = [];
  });

  it("retains version, payload, fallback and invocation through the native HTML data export", async () => {
    const result = bindPluginInlineViewInvocation(
      createPluginInlineViewResult(
        "incidents",
        "incident",
        { incidentId: "INC-42" },
        { version: 3, summary: "INC-42 is investigating." },
      ),
      "incidents",
      "show_incident",
      "call-1",
    );
    const message = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "show_incident",
      ...result,
      __openclaw: { runId: "run-1" },
    };
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "display-1",
        parentId: null,
        timestamp: "2026-10-19T12:00:00Z",
        message,
      },
    ];
    const params = makeParams();
    await buildExportSessionReply(params);
    const restored = sessionDataFromHtml(await writtenHtml(params));
    expect(restored.entries).toEqual(hoisted.sessionTranscriptEvents);
    expect(projectPluginInlineView(result.details, message)).toMatchObject({
      version: 3,
      summary: "INC-42 is investigating.",
      payload: { incidentId: "INC-42" },
    });
  });

  it.each(["monthly report.html", "reports/monthly  report.html"])(
    "preserves the complete structured export path %j",
    async (outputPath) => {
      const command = expectDefined(findCommandByNativeName("export-session"), "export command");
      const params = makeParams();
      params.command.commandBodyNormalized = buildCommandTextFromArgs(command, {
        values: { path: outputPath },
      });

      const reply = await buildExportSessionReply(params);

      expect(reply.text).toContain(`📄 File: ${outputPath}`);
      expect(await fs.readFile(path.join(params.workspaceDir, outputPath), "utf-8")).toContain(
        'id="session-data"',
      );
    },
  );

  it("preserves an explicitly empty branch selected by a terminal leaf control", async () => {
    const entries = [
      {
        type: "message",
        id: "inactive-tail",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: "inactive" },
      },
      {
        type: "leaf",
        id: "empty-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:02.000Z",
        targetId: null,
      },
      {
        type: "metadata",
        id: "opaque-after-leaf",
        parentId: "inactive-tail",
      },
    ];
    hoisted.sessionTranscriptEvents = entries;

    const params = makeParams();
    await buildExportSessionReply(params);

    const html = await writtenHtml(params);
    expect(html).not.toContain("{{CSS}}");
    expect(html).not.toContain("{{JS}}");
    expect(html).not.toContain("{{SESSION_DATA}}");
    expect(html).not.toContain("{{MARKED_JS}}");
    expect(html).not.toContain("{{HIGHLIGHT_JS}}");
    expect(html).not.toContain("data-openclaw-export-placeholder");
    expect(html).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [entries[0], { ...entries[1], parentId: null }, entries[2]],
          leafId: null,
          hasLeafControl: true,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
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
    hoisted.exportHtmlTemplateContents.set("template.css", "$&$1");
    hoisted.exportHtmlTemplateContents.set("template.js", "const marker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set("vendor/marked.min.js", "const markedMarker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set(
      "vendor/highlight.min.js",
      "const highlightMarker = '$&$1';",
    );

    const params = makeParams();
    await buildExportSessionReply(params);

    const html = await writtenHtml(params);
    expect(html).toContain("$&$1");
    expect(html).toContain("const marker = '$&$1';");
    expect(html).toContain("const markedMarker = '$&$1';");
    expect(html).toContain("const highlightMarker = '$&$1';");
  });

  it("skips invalid loaded transcript events before exporting", async () => {
    hoisted.sessionTranscriptEvents = [
      messageEntry("entry-1", { role: "user", content: "valid user" }, 0),
      messageEntry("entry-2", { content: "missing role" }, 1),
      messageEntry("entry-3", { role: "assistant", content: "valid assistant" }, 2),
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("📊 Entries: 2");
    expect(reply.text).toContain(
      "⚠️ Skipped 1 malformed transcript row that was not a session entry. rows 2",
    );
  });

  it("marks the skipped-row list as truncated when more than 20 rows are invalid", async () => {
    hoisted.sessionTranscriptEvents = [
      ...Array.from({ length: 25 }, (_, index) => ({
        type: "message",
        id: `bad-${index + 1}`,
        timestamp: `2026-05-16T00:00:${String(index).padStart(2, "0")}.000Z`,
        message: { content: "missing role" },
      })),
      messageEntry("entry-valid", { role: "assistant", content: "valid assistant" }, 60),
    ];

    const reply = await buildExportSessionReply(makeParams());

    const expectedRows = Array.from({ length: 20 }, (_, index) => index + 1).join(", ");
    expect(reply.text).toContain(
      `⚠️ Skipped 25 malformed transcript rows that were not session entries. rows ${expectedRows}, …`,
    );
  });

  it.each(["cli", "stored-acp", "unreadable-acp", "assistant"] as const)(
    "handles backend transcript warnings for %s sessions",
    async (kind) => {
      hoisted.loadSessionStoreMock.mockReturnValue({
        "agent:target:session": {
          sessionId: "session-1",
          updatedAt: 1,
          ...(kind === "cli"
            ? { cliSessionBindings: { "claude-cli": { sessionId: "backend-session-1" } } }
            : {}),
          ...(kind === "assistant" ? { acp: acpMetadata } : {}),
        },
      });
      if (kind === "stored-acp") {
        hoisted.readAcpSessionMetaForEntryAsyncMock.mockResolvedValue(acpMetadata);
      } else if (kind === "unreadable-acp") {
        hoisted.readAcpSessionMetaForEntryAsyncMock.mockRejectedValueOnce(
          new Error("state database unavailable"),
        );
      }
      hoisted.sessionTranscriptEvents = userTranscript();
      if (kind === "cli" || kind === "assistant") {
        hoisted.sessionTranscriptEvents.push(
          messageEntry(
            "entry-2",
            {
              role: kind === "cli" ? "user" : "assistant",
              content: kind === "cli" ? "world" : "hi",
            },
            1,
          ),
        );
      }
      const params = makeParams();
      const reply = await buildExportSessionReply(params);
      const warning = sessionDataFromHtml(await writtenHtml(params)).warning;
      if (kind === "cli" || kind === "stored-acp") {
        expect(reply.text).toContain("backend runtime");
        expect(warning).toContain("backend runtime");
        if (kind === "cli") {
          expect(reply.text).toContain("not included in this export");
          expect(typeof warning).toBe("string");
        } else {
          expect(hoisted.readAcpSessionMetaForEntryAsyncMock).toHaveBeenCalledWith({
            cfg: {},
            sessionKey: "agent:target:session",
            entry: { sessionId: "session-1", updatedAt: 1 },
          });
        }
      } else {
        expect(reply.text).not.toContain("backend runtime");
        expect(warning).toBeUndefined();
        if (kind === "unreadable-acp") {
          expect(reply.text).toContain("Session exported");
        } else {
          expect(reply.text).not.toContain("not included in this export");
        }
      }
    },
  );

  describe("filesystem boundary", () => {
    beforeEach(() => {
      hoisted.exportHtmlTemplateContents.set(
        "template.html",
        [
          '<style data-openclaw-export-placeholder="CSS"></style>',
          '<script id="session-data" data-openclaw-export-placeholder="SESSION_DATA"></script>',
          '<script data-openclaw-export-placeholder="MARKED_JS"></script>',
          '<script data-openclaw-export-placeholder="HIGHLIGHT_JS"></script>',
          '<script data-openclaw-export-placeholder="JS"></script>',
        ].join(""),
      );
      hoisted.exportHtmlTemplateContents.set("template.css", "new export");
      hoisted.exportHtmlTemplateContents.set("template.js", "");
      hoisted.exportHtmlTemplateContents.set("vendor/marked.min.js", "");
      hoisted.exportHtmlTemplateContents.set("vendor/highlight.min.js", "");
    });

    it.each([
      ["relative", "exports/session.html"],
      ["absolute", null],
    ])("writes an explicit %s path inside the workspace", async (_label, requestedPath) => {
      const params = makeParams();
      const targetPath = requestedPath ?? path.join(params.workspaceDir, "exports", "session.html");
      params.command.commandBodyNormalized = `/export-session ${targetPath}`;

      const reply = await buildExportSessionReply(params);
      const absolutePath = path.join(
        await fs.realpath(params.workspaceDir),
        "exports",
        "session.html",
      );

      expect(reply.text).toContain(`📄 File: ${path.join("exports", "session.html")}`);
      expect(await fs.readFile(absolutePath, "utf-8")).toContain("<style>new export</style>");
      if (process.platform !== "win32") {
        expect((await fs.stat(absolutePath)).mode & 0o777).toBe(0o600);
      }
    });

    it("preserves explicit overwrite behavior for an in-workspace regular file", async () => {
      const params = makeParams();
      const targetPath = path.join(params.workspaceDir, "session.html");
      await fs.writeFile(targetPath, "old export", "utf-8");
      if (process.platform !== "win32") {
        await fs.chmod(targetPath, 0o644);
      }

      await buildExportSessionReply(params);

      const html = await writtenHtml(params);
      expect(html).toContain("<style>new export</style>");
      expect(html).not.toContain("old export");
      if (process.platform !== "win32") {
        expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
      }
    });

    it.each(["absolute", "traversal"] as const)(
      "refuses an %s escape with a bounded error and no outside write",
      async (kind) => {
        const parentDir = tempDirs.make("openclaw-session-export-escape-");
        const workspaceDir = path.join(parentDir, "workspace");
        await fs.mkdir(workspaceDir);
        const params = makeParams(workspaceDir);
        const outsidePath = path.join(parentDir, "outside.html");
        params.command.commandBodyNormalized = `/export-session ${kind === "absolute" ? outsidePath : "../outside.html"}`;

        await expect(buildExportSessionReply(params)).resolves.toEqual({
          text: "❌ Output path must be a regular file inside the workspace.",
        });
        await expect(fs.stat(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it.runIf(process.platform !== "win32")(
      "accepts an absolute path written through a symlinked workspace root",
      async () => {
        const workspaceDir = tempDirs.make("openclaw-session-export-");
        const aliasParent = tempDirs.make("openclaw-session-export-alias-");
        const workspaceAlias = path.join(aliasParent, "workspace");
        await fs.symlink(workspaceDir, workspaceAlias, "dir");
        const params = makeParams(workspaceAlias);
        params.command.commandBodyNormalized = `/export-session ${path.join(workspaceAlias, "exports", "session.html")}`;

        const reply = await buildExportSessionReply(params);
        const absolutePath = path.join(await fs.realpath(workspaceDir), "exports", "session.html");

        expect(reply.text).toContain(`📄 File: ${path.join("exports", "session.html")}`);
        expect(await fs.readFile(absolutePath, "utf-8")).toContain("<style>new export</style>");
      },
    );

    it.runIf(process.platform !== "win32")(
      "rejects a symlink target without changing the linked file",
      async () => {
        const params = makeParams();
        const outsideDir = tempDirs.make("openclaw-session-export-outside-");
        const outsidePath = path.join(outsideDir, "outside.html");
        await fs.writeFile(outsidePath, "outside", "utf-8");
        await fs.symlink(outsidePath, path.join(params.workspaceDir, "session.html"));

        await expect(buildExportSessionReply(params)).resolves.toEqual({
          text: "❌ Output path must be a regular file inside the workspace.",
        });
        expect(await fs.readFile(outsidePath, "utf-8")).toBe("outside");
      },
    );

    it("suffixes a colliding generated filename instead of overwriting", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-05-16T00:00:00Z"));
      try {
        const params = makeParams();
        params.command.commandBodyNormalized = "/export-session";
        const basename = "openclaw-session-session--2026-05-16T00-00-00";
        await fs.writeFile(path.join(params.workspaceDir, `${basename}.html`), "existing", "utf-8");

        const reply = await buildExportSessionReply(params);

        expect(reply.text).toContain(`📄 File: ${basename}-2.html`);
        expect(await fs.readFile(path.join(params.workspaceDir, `${basename}.html`), "utf-8")).toBe(
          "existing",
        );
        expect(
          await fs.readFile(path.join(params.workspaceDir, `${basename}-2.html`), "utf-8"),
        ).toContain("<style>new export</style>");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

await import("./commands-export-trajectory.test-support.js");
