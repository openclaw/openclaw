// Session file method tests cover transcript-linked files plus the workspace browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync,
  };
});

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

type SessionFilesMethod = "sessions.files.list" | "sessions.files.get";

async function invokeSessionFilesHandler(
  method: SessionFilesMethod,
  params: Record<string, unknown>,
) {
  const responder = createResponder();
  await sessionsFilesHandlers[method]?.({
    req: { type: "req", id: method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: {} as never,
  });
  return responder.calls;
}

function expectOkPayload(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

function expectError(calls: ReturnType<typeof createResponder>["calls"]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  return calls[0]?.error as Record<string, any>;
}

function assistantToolCall(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name,
        arguments: args,
      },
    ],
  };
}

function writeWorkspaceFile(root: string, filePath: string, content: string) {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}

describe("sessions.files RPC handlers", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-files-test-"));
    hoisted.resolveDefaultAgentId.mockReturnValue("main");
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
    writeWorkspaceFile(workspaceRoot, "package.json", '{"name":"openclaw-test"}\n');
    writeWorkspaceFile(workspaceRoot, "src/readme.md", "# Read me\n");
    writeWorkspaceFile(workspaceRoot, "ui/chat.ts", "export const chat = true;\n");
    writeWorkspaceFile(workspaceRoot, "ui/vite.config.ts", "export default {};\n");

    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: workspaceRoot,
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      [
        assistantToolCall("edit", { path: "ui/chat.ts" }),
        assistantToolCall("read", { path: "src/readme.md" }),
        assistantToolCall("apply_patch", {
          input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
        }),
      ].forEach((message, index) => visit(message, index + 1));
      return 3;
    });
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("lists session-touched files with a browser rooted at the session workspace", async () => {
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["package.json", "modified"],
      ["ui/chat.ts", "modified"],
      ["src/readme.md", "read"],
    ]);
    expect(payload.browser.path).toBe("");
    expect(
      payload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["src", "directory", "read"],
      ["ui", "directory", "modified"],
      ["package.json", "file", "modified"],
    ]);
  });

  it("collects touched files from existing transcript tool-call spellings", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "read",
              input: { path: "src/readme.md" },
            },
            {
              type: "toolcall",
              name: "edit",
              arguments: { path: "ui/vite.config.ts" },
            },
            { type: "tool_use", name: "read", args: { path: "ui/chat.ts" } },
            {
              type: "tool_call",
              name: "apply_patch",
              input: {
                input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
              },
            },
          ],
        },
        1,
      );
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["package.json", "modified"],
      ["ui/vite.config.ts", "modified"],
      ["src/readme.md", "read"],
      ["ui/chat.ts", "read"],
    ]);
  });

  it("collects changed files from structured apply_patch changes", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(
        assistantToolCall("apply_patch", {
          changes: [
            { path: "ui/chat.ts", kind: "update" },
            { path: "src/readme.md", kind: "delete" },
            {
              path: "old-name.md",
              kind: { type: "update", move_path: "package.json" },
            },
          ],
        }),
        1,
      );
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["old-name.md", "modified"],
      ["package.json", "modified"],
      ["src/readme.md", "modified"],
      ["ui/chat.ts", "modified"],
    ]);
  });

  it("prefers the spawned workspace root over a nested spawned cwd", async () => {
    const nestedCwd = path.join(workspaceRoot, "packages/app");
    fs.mkdirSync(nestedCwd, { recursive: true });
    writeWorkspaceFile(workspaceRoot, "packages/app/src/readme.md", "# Nested read me\n");
    writeWorkspaceFile(workspaceRoot, "packages/shared/config.ts", "export const shared = true;\n");
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: nestedCwd,
        spawnedWorkspaceDir: workspaceRoot,
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      visit(assistantToolCall("read", { path: "../shared/config.ts" }), 2);
      return 2;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "../shared/config.ts",
      }),
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
    expect(
      payload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["packages", "directory", "read"],
      ["src", "directory", undefined],
      ["ui", "directory", undefined],
      ["package.json", "file", undefined],
    ]);

    const preview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "src/readme.md",
      }),
    );
    expect(preview.file.content).toBe("# Nested read me\n");

    const browserPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "packages/app/src/readme.md",
      }),
    );
    expect(browserPreview.file.content).toBe("# Nested read me\n");

    const parentRelativePreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "../shared/config.ts",
      }),
    );
    expect(parentRelativePreview.file.content).toBe("export const shared = true;\n");

    const parentRelativeBrowserPreview = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "packages/shared/config.ts",
      }),
    );
    expect(parentRelativeBrowserPreview.file.content).toBe("export const shared = true;\n");
  });

  it("falls back to the configured agent workspace for sessions without spawned metadata", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "main");
    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
    expect(payload.browser).toBeDefined();
  });

  it("uses the canonical session owner for configured workspace fallback", async () => {
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:aiden:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(hoisted.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "aiden");
    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
  });

  it("browses and searches workspace files without previewing browser-only files", async () => {
    const folderPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: "ui",
      }),
    );

    expect(folderPayload.browser.parentPath).toBe("");
    expect(
      folderPayload.browser.entries.map((entry: Record<string, unknown>) => [
        entry.path,
        entry.kind,
        entry.sessionKind,
      ]),
    ).toEqual([
      ["ui/chat.ts", "file", "modified"],
      ["ui/vite.config.ts", "file", undefined],
    ]);

    const searchPayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        search: "vite",
      }),
    );

    expect(searchPayload.browser.search).toBe("vite");
    expect(
      searchPayload.browser.entries.map((entry: Record<string, unknown>) => entry.path),
    ).toEqual(["ui/vite.config.ts"]);

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
      }),
    );

    expect(error.details).toMatchObject({
      path: "ui/vite.config.ts",
      type: "session_file_not_found",
    });
  });

  it("truncates broad workspace searches by visited entries, not only by matches", async () => {
    for (let index = 0; index < 5_025; index += 1) {
      writeWorkspaceFile(workspaceRoot, `bulk-${String(index).padStart(4, "0")}.txt`, "");
    }
    writeWorkspaceFile(workspaceRoot, "zz-tail-needle.ts", "export const needle = true;\n");

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        search: "needle",
      }),
    );

    expect(payload.browser).toMatchObject({
      search: "needle",
      truncated: true,
    });
    expect(payload.browser.entries).toEqual([]);
  });

  it("does not read absolute paths outside the configured workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "missing-session.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: outsidePath }), 1);
      return 1;
    });

    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: outsidePath,
        }),
      );

      expect(error.details).toMatchObject({
        path: outsidePath,
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("does not follow workspace symlinks for file previews", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-linked-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "linked outside\n", "utf8");
    fs.symlinkSync(outsidePath, path.join(workspaceRoot, "linked.txt"));

    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "linked.txt",
        }),
      );

      expect(error.details).toMatchObject({
        path: "linked.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("does not follow symlinked parent directories for file previews", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-linked-parent-"));
    writeWorkspaceFile(outsideDir, "secret.txt", "linked parent outside\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    try {
      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "linked-dir/secret.txt",
        }),
      );

      expect(error.details).toMatchObject({
        path: "linked-dir/secret.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns integer file timestamps for protocol responses", async () => {
    const datedPath = path.join(workspaceRoot, "dated.txt");
    writeWorkspaceFile(workspaceRoot, "dated.txt", "dated\n");
    fs.utimesSync(datedPath, 1_700_000_000.123, 1_700_000_000.123);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    const entry = payload.browser.entries.find(
      (browserEntry: Record<string, unknown>) => browserEntry.path === "dated.txt",
    );

    expect(Number.isInteger(entry.updatedAtMs)).toBe(true);
  });

  it("does not browse paths outside the session workspace root", async () => {
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
        path: "../",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.browser).toBeUndefined();
  });

  it("does not derive a workspace root from transcript cwd", async () => {
    const sessionsDir = path.join(workspaceRoot, "custom-sessions");
    const transcriptCwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-cwd-"));
    writeWorkspaceFile(transcriptCwd, "secret.txt", "transcript cwd secret\n");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sess-main.jsonl"),
      `${JSON.stringify({ cwd: transcriptCwd })}\n`,
      "utf8",
    );
    hoisted.loadSessionEntry.mockReturnValue({
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(sessionsDir, "sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "secret.txt" }), 1);
      return 1;
    });
    try {
      const listPayload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.list", {
          sessionKey: "agent:main:main",
        }),
      );

      expect(listPayload.root).toBe(workspaceRoot);
      expect(listPayload.browser).toBeDefined();
      expect(listPayload.files).toMatchObject([
        {
          missing: true,
          path: "secret.txt",
        },
      ]);

      const error = expectError(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: "secret.txt",
        }),
      );
      expect(error.details).toMatchObject({
        path: "secret.txt",
        type: "session_file_not_found",
      });
    } finally {
      fs.rmSync(transcriptCwd, { recursive: true, force: true });
    }
  });

  it("reports oversized existing files without marking them missing", async () => {
    writeWorkspaceFile(workspaceRoot, "large.log", "x".repeat(260 * 1024));
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "large.log" }), 1);
      return 1;
    });

    const error = expectError(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "large.log",
      }),
    );

    expect(error.details).toMatchObject({
      maxPreviewBytes: 256 * 1024,
      path: "large.log",
      size: 260 * 1024,
      type: "session_file_too_large",
    });
  });

  it("excludes workspace-external files from the workspace rail list", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside content\n", "utf8");
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      // Read a file inside the workspace and one outside
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      visit(assistantToolCall("read", { path: "../outside.txt" }), 2);
      return 2;
    });

    try {
      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.list", {
          sessionKey: "agent:main:main",
        }),
      );

      // The workspace-internal file should be listed
      const insideFiles = payload.files.filter(
        (f: Record<string, unknown>) => f.path === "src/readme.md",
      );
      expect(insideFiles).toHaveLength(1);

      // The outside file should NOT appear in the list (filtered out)
      const outsideFiles = payload.files.filter(
        (f: Record<string, unknown>) => f.path === "../outside.txt",
      );
      expect(outsideFiles).toHaveLength(0);

      // No entries should have missing=true for files that exist outside
      const missingEntries = payload.files.filter(
        (f: Record<string, unknown>) => f.missing === true,
      );
      expect(missingEntries).toHaveLength(0);
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it("excludes path-traversal files (../../etc/passwd)", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      visit(assistantToolCall("read", { path: "../../etc/passwd" }), 2);
      return 2;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    // Internal file present
    expect(payload.files.some((f: Record<string, unknown>) => f.path === "src/readme.md")).toBe(true);
    // Path traversal file excluded
    expect(payload.files.some((f: Record<string, unknown>) => f.path === "../../etc/passwd")).toBe(false);
  });

  it("shows missing=true for workspace-internal files that do not exist on disk", async () => {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
      visit(assistantToolCall("read", { path: "src/deleted-file.ts" }), 2);
      return 2;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    const missingFile = payload.files.find(
      (f: Record<string, unknown>) => f.path === "src/deleted-file.ts",
    );
    expect(missingFile).toBeDefined();
    expect(missingFile.missing).toBe(true);
  });

  it("includes files in nested workspace subdirectories", async () => {
    writeWorkspaceFile(workspaceRoot, "deep/nested/lib/helper.ts", "export const help = true;\n");
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: "deep/nested/lib/helper.ts" }), 1);
      return 1;
    });

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    const nestedFile = payload.files.find(
      (f: Record<string, unknown>) => f.path === "deep/nested/lib/helper.ts",
    );
    expect(nestedFile).toBeDefined();
    expect(nestedFile.missing).toBe(false);
  });

  it("excludes files read via absolute paths that point outside the workspace", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-absolute-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      visit(assistantToolCall("read", { path: outsidePath }), 1);
      return 1;
    });

    try {
      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.list", {
          sessionKey: "agent:main:main",
        }),
      );

      const outsideFile = payload.files.find(
        (f: Record<string, unknown>) => f.path === outsidePath,
      );
      expect(outsideFile).toBeUndefined();
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });
});
