// Session file method tests cover transcript-linked files plus the workspace browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";

const hoisted = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
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
    writeWorkspaceFile(workspaceRoot, "package.json", '{"name":"openclaw-test"}\n');
    writeWorkspaceFile(workspaceRoot, "src/readme.md", "# Read me\n");
    writeWorkspaceFile(workspaceRoot, "ui/chat.ts", "export const chat = true;\n");
    writeWorkspaceFile(workspaceRoot, "ui/vite.config.ts", "export default {};\n");

    hoisted.loadSessionEntry.mockReturnValue({
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: workspaceRoot,
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        [
          assistantToolCall("edit", { path: "ui/chat.ts" }),
          assistantToolCall("read", { path: "src/readme.md" }),
          assistantToolCall("apply_patch", {
            input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
          }),
        ].forEach((message, index) => visit(message, index + 1));
        return 3;
      },
    );
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
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        visit(
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "read", input: { path: "src/readme.md" } },
              { type: "toolcall", name: "edit", arguments: { path: "ui/vite.config.ts" } },
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
      },
    );

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.files.map((file: Record<string, unknown>) => [file.path, file.kind])).toEqual([
      ["package.json", "modified"],
      ["ui/vite.config.ts", "modified"],
      ["src/readme.md", "read"],
    ]);
  });

  it("prefers the spawned workspace root over a nested spawned cwd", async () => {
    const nestedCwd = path.join(workspaceRoot, "packages/app");
    fs.mkdirSync(nestedCwd, { recursive: true });
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
        spawnedCwd: nestedCwd,
        spawnedWorkspaceDir: workspaceRoot,
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        visit(assistantToolCall("read", { path: "src/readme.md" }), 1);
        return 1;
      },
    );

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toEqual([
      expect.objectContaining({
        missing: false,
        path: "src/readme.md",
      }),
    ]);
  });

  it("browses folders, searches files, and reads browser-only files inside the workspace", async () => {
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

    const filePayload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "ui/vite.config.ts",
      }),
    );

    expect(filePayload.file).toMatchObject({
      content: "export default {};\n",
      kind: "read",
      missing: false,
      name: "vite.config.ts",
      path: "ui/vite.config.ts",
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

  it("does not read absolute paths when the session has no workspace root", async () => {
    const outsidePath = path.join(os.tmpdir(), `openclaw-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: path.join(workspaceRoot, ".sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "missing-session.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        visit(assistantToolCall("read", { path: outsidePath }), 1);
        return 1;
      },
    );

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

  it("reads transcript cwd from custom session store directories", async () => {
    const sessionsDir = path.join(workspaceRoot, "custom-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sess-main.jsonl"),
      `${JSON.stringify({ cwd: workspaceRoot })}\n`,
      "utf8",
    );
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: path.join(sessionsDir, "sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        visit(assistantToolCall("read", { path: "ui/chat.ts" }), 1);
        return 1;
      },
    );

    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.files).toMatchObject([
      {
        missing: false,
        path: "ui/chat.ts",
      },
    ]);
  });

  it("reports oversized existing files without marking them missing", async () => {
    writeWorkspaceFile(workspaceRoot, "large.log", "x".repeat(260 * 1024));

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
});
