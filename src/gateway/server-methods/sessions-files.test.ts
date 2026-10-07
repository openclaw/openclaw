import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { root as openSafeRoot } from "../../infra/fs-safe.js";
import { resolveOpenPathCommand } from "./open-path.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  TEXT_PREVIEW_FIXTURES,
  useSqliteSession,
  visibleMessageEvent,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readDelta: vi.fn(),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-transcript-readers.js", async (original) => ({
  ...(await original<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta,
}));

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
function listFiles(params: Record<string, unknown> = {}) {
  return invoke("sessions.files.list", { sessionKey, ...params });
}

function getFile(filePath: string) {
  return invoke("sessions.files.get", { sessionKey, path: filePath });
}

function saveFile(params: Record<string, unknown>) {
  return invoke("sessions.files.set", { sessionKey, ...params });
}

const outsideDirs = useAutoCleanupTempDirTracker(afterEach);
const outsideFile = () => path.join(outsideDirs.make("session-files-outside-"), "outside.txt");

const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(
    { ...hoisted, readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta },
    mockVisibleMessages,
  );
});

afterEach(() => {
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files RPC handlers", () => {
  function mockSession(
    entry: Record<string, unknown>,
    agentId = "main",
    storePath = path.join(workspaceRoot, ".sessions.json"),
  ) {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId,
      canonicalKey: `agent:${agentId}:main`,
      cfg: {},
      storePath,
      entry,
    });
  }

  function fixedStoreConfig() {
    return {
      session: { store: path.join(workspaceRoot, "shared.sqlite"), scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } as const;
  }

  it("reveals the same workspace root returned by sessions.files.list", async () => {
    const listPayload = expectOkPayload(await listFiles());
    const revealPayload = expectOkPayload(
      await invoke("sessions.files.reveal", {
        key: sessionKey,
      }),
    );

    expect(revealPayload).toEqual({ ok: true, path: listPayload.root });
    // Compare against the resolver's own output so the assertion holds on
    // every supported platform (open / xdg-open / PowerShell Start-Process).
    expect(hoisted.execOpenPath).toHaveBeenCalledWith(
      resolveOpenPathCommand(listPayload.root as string),
    );
  });

  it("returns no workspace listing while the session checkout is pending", async () => {
    mockSession({ sessionId: "sess-pending", pendingWorktree: { titleSource: "New checkout" } });
    mockVisibleMessages([]);

    expect(expectOkPayload(await listFiles())).toEqual({
      sessionKey,
      files: [],
    });
  });

  it("uses the persisted fixed-store owner for a bare session workspace", async () => {
    const cfg = fixedStoreConfig();
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "ops",
      canonicalKey: "global",
      cfg,
      storePath: cfg.session.store,
      entry: { sessionId: "sess-owned-global" },
    });
    hoisted.resolveAgentWorkspaceDir.mockImplementation((_cfg: unknown, agentId: string) =>
      agentId === "ops" ? workspaceRoot : path.join(workspaceRoot, "wrong-research"),
    );

    const payload = expectOkPayload(
      await invoke(
        "sessions.files.list",
        { sessionKey: "global" },
        { getRuntimeConfig: () => cfg },
      ),
    );

    expect(payload.root).toBe(workspaceRoot);
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(hoisted.readDelta).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", sessionKey: "global" }),
      expect.any(Object),
    );
  });

  it("rejects a foreign agent before a bare fixed-store workspace write", async () => {
    const cfg = fixedStoreConfig();

    const error = expectError(
      await invoke(
        "sessions.files.set",
        {
          sessionKey: "global",
          agentId: "research",
          path: "ui/chat.ts",
          content: "foreign write\n",
          expectedHash: hashContent("export const chat = true;\n"),
        },
        { getRuntimeConfig: () => cfg },
      ),
    );

    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'agent "research" does not match session key agent "ops"',
    });
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/chat.ts"), "utf8")).toBe(
      "export const chat = true;\n",
    );
  });

  it("refuses to reveal a remote session workspace", async () => {
    const payload = expectOkPayload(
      await invoke(
        "sessions.files.reveal",
        { key: sessionKey },
        {
          workerSessionPlacementService: {
            getMany: () => new Map([["sess-main", { state: "active" }]]),
          },
        },
      ),
    );

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("runs remotely");
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("refuses to reveal an exec-node session workspace", async () => {
    mockSession({
      sessionId: "sess-main",
      sessionFile: "sess-main.jsonl",
      spawnedCwd: workspaceRoot,
      execNode: "build-mac",
    });

    const payload = expectOkPayload(await invoke("sessions.files.reveal", { key: sessionKey }));

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("exec node");
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("refuses to reveal when the session has no workspace root", async () => {
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(undefined);
    mockSession({ sessionId: "sess-main", sessionFile: "sess-main.jsonl" });

    const payload = expectOkPayload(await invoke("sessions.files.reveal", { key: sessionKey }));

    expect(payload).toEqual({
      ok: false,
      error: "No workspace root is available for this session.",
    });
    expect(hoisted.execOpenPath).not.toHaveBeenCalled();
  });

  it("returns opener failures as successful RPC results", async () => {
    const warn = vi.fn();
    hoisted.execOpenPath.mockRejectedValueOnce(new Error("xdg-open: no method available"));

    const payload = expectOkPayload(
      await invoke("sessions.files.reveal", { key: sessionKey }, { logGateway: { warn } }),
    );

    expect(payload).toMatchObject({ ok: false, path: workspaceRoot });
    expect(payload.error).toContain("headless environment");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sessions.files.reveal failed path="),
    );
  });

  it("prefers the spawned workspace root over a nested spawned cwd", async () => {
    const nestedCwd = path.join(workspaceRoot, "packages/app");
    fs.mkdirSync(nestedCwd, { recursive: true });
    writeWorkspaceFile(workspaceRoot, "packages/app/src/readme.md", "# Nested read me\n");
    writeWorkspaceFile(workspaceRoot, "packages/shared/config.ts", "export const shared = true;\n");
    mockSession({
      sessionId: "sess-main",
      sessionFile: "sess-main.jsonl",
      spawnedCwd: nestedCwd,
      spawnedWorkspaceDir: workspaceRoot,
    });
    mockVisibleMessages([
      assistantToolCall("read", { path: "src/readme.md" }),
      assistantToolCall("read", { path: "../shared/config.ts" }),
    ]);

    const payload = expectOkPayload(await listFiles());

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

    const preview = expectOkPayload(await getFile("src/readme.md"));
    expect(preview.file.content).toBe("# Nested read me\n");
    expect(preview.file.workspacePath).toBe("packages/app/src/readme.md");

    const workspaceRootPreview = expectOkPayload(
      await getFile(path.join(workspaceRoot, "src/readme.md")),
    );
    expect(workspaceRootPreview.file.content).toBe("# Read me\n");
    expect(workspaceRootPreview.file.workspacePath).toBe("src/readme.md");

    const browserPreview = expectOkPayload(await getFile("packages/app/src/readme.md"));
    expect(browserPreview.file.content).toBe("# Nested read me\n");

    const aliasedPreview = expectOkPayload(await getFile("packages//app/src/readme.md"));
    expect(aliasedPreview.file.workspacePath).toBe("packages/app/src/readme.md");

    const parentRelativePreview = expectOkPayload(await getFile("../shared/config.ts"));
    expect(parentRelativePreview.file.content).toBe("export const shared = true;\n");

    const parentRelativeBrowserPreview = expectOkPayload(
      await getFile("packages/shared/config.ts"),
    );
    expect(parentRelativeBrowserPreview.file.content).toBe("export const shared = true;\n");
  });

  it("round-trips listed folders beginning with two dots", async () => {
    writeWorkspaceFile(workspaceRoot, "..notes/readme.md", "# Notes\n");
    const root = expectOkPayload(await listFiles());
    const selected = root.browser.entries.find(
      (entry: Record<string, unknown>) => entry.name === "..notes",
    );
    const folder = expectOkPayload(await listFiles({ path: selected.path }));
    expect(folder.browser).toMatchObject({
      path: "..notes",
      parentPath: "",
      entries: [{ path: "..notes/readme.md", kind: "file" }],
    });
    const preview = expectOkPayload(await getFile(folder.browser.entries[0].path));
    expect(preview.file.content).toBe("# Notes\n");
  });

  it("browses, searches, and previews files not referenced by the session", async () => {
    const folderPayload = expectOkPayload(await listFiles({ path: "ui" }));

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

    const searchPayload = expectOkPayload(await listFiles({ search: "vite" }));

    expect(searchPayload.browser.search).toBe("vite");
    expect(
      searchPayload.browser.entries.map((entry: Record<string, unknown>) => entry.path),
    ).toEqual(["ui/vite.config.ts"]);

    const preview = expectOkPayload(await getFile("ui/vite.config.ts"));

    expect(preview.file).toMatchObject({
      content: "export default {};\n",
      contentEncoding: "utf8",
      hash: hashContent("export default {};\n"),
      kind: "read",
      mimeType: "text/plain",
      missing: false,
      path: "ui/vite.config.ts",
      previewKind: "text",
    });
  });

  it("truncates broad workspace searches by visited entries, not only by matches", async () => {
    for (let index = 0; index < 5_025; index += 1) {
      writeWorkspaceFile(workspaceRoot, `bulk-${String(index).padStart(4, "0")}.txt`, "");
    }
    writeWorkspaceFile(workspaceRoot, "zz-tail-needle.ts", "export const needle = true;\n");

    const payload = expectOkPayload(await listFiles({ search: "needle" }));

    expect(payload.browser).toMatchObject({
      search: "needle",
      truncated: true,
    });
    expect(payload.browser.entries).toEqual([]);
  });

  it.runIf(process.platform === "linux").each([{ operation: "browse", query: { path: "ui" } }])(
    "reports non-UTF-8 filenames during workspace $operation",
    async ({ query }) => {
      const invalidPath = Buffer.concat([
        Buffer.from(path.join(workspaceRoot, "ui") + path.sep),
        Buffer.from([0xff]),
      ]);
      fs.writeFileSync(invalidPath, "unaddressable file");

      await expect(listFiles(query)).rejects.toMatchObject({
        code: "invalid-path",
        message: 'Cannot list workspace directory "ui": directory entry name is not valid UTF-8',
      });
      expect(fs.readFileSync(path.join(workspaceRoot, "ui", "vite.config.ts"), "utf8")).toBe(
        "export default {};\n",
      );
      expect(fs.readFileSync(invalidPath, "utf8")).toBe("unaddressable file");
    },
  );

  it("does not follow symlinked parent directories for file previews", async () => {
    const outsideDir = outsideDirs.make("session-files-parent-");
    writeWorkspaceFile(outsideDir, "secret.txt", "linked parent outside\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    const error = expectError(await getFile("linked-dir/secret.txt"));

    expect(error.details).toMatchObject({
      path: "linked-dir/secret.txt",
      type: "session_file_not_found",
    });
  });

  it("does not browse paths outside the session workspace root", async () => {
    const payload = expectOkPayload(await listFiles({ path: "../" }));

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.browser).toBeUndefined();
  });

  it("does not derive a workspace root from transcript cwd", async () => {
    const sessionsDir = path.join(workspaceRoot, "custom-sessions");
    const transcriptCwd = outsideDirs.make("session-files-transcript-");
    writeWorkspaceFile(transcriptCwd, "secret.txt", "transcript cwd secret\n");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "sess-main.jsonl"),
      `${JSON.stringify({ cwd: transcriptCwd })}\n`,
      "utf8",
    );
    hoisted.loadSessionEntry.mockReturnValue({
      agentId: "main",
      canonicalKey: "agent:main:main",
      cfg: {},
      storePath: path.join(sessionsDir, "sessions.json"),
      entry: {
        sessionId: "sess-main",
        sessionFile: "sess-main.jsonl",
      },
    });
    mockVisibleMessages([assistantToolCall("read", { path: "secret.txt" })]);
    const listPayload = expectOkPayload(await listFiles());

    expect(listPayload.root).toBe(workspaceRoot);
    expect(listPayload.browser).toBeDefined();
    expect(listPayload.files).toMatchObject([
      {
        missing: true,
        path: "secret.txt",
      },
    ]);

    const error = expectError(await getFile("secret.txt"));
    expect(error.details).toMatchObject({
      path: "secret.txt",
      type: "session_file_not_found",
    });
  });

  it("allows only one concurrent save across nested workspace aliases", async () => {
    const original = "export default {};\n";
    const expectedHash = hashContent(original);
    const firstSave = saveFile({
      path: "ui/vite.config.ts",
      content: "export default { first: true };\n",
      expectedHash,
    });
    mockSession({ sessionId: "nested", spawnedCwd: path.join(workspaceRoot, "ui") });
    const [first, second] = await Promise.all([
      firstSave,
      saveFile({
        path: "./vite.config.ts",
        content: "export default { second: true };\n",
        expectedHash,
      }),
    ]);

    const calls = [...first, ...second];
    expect(calls.filter((call) => call?.ok)).toHaveLength(1);
    const conflict = expectError(calls.filter((call) => !call.ok));
    expect(conflict.details).toMatchObject({ type: "session_file_conflict" });
    const content = fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8");
    expect(["export default { first: true };\n", "export default { second: true };\n"]).toContain(
      content,
    );
    expect(conflict.details.currentHash).toBe(hashContent(content));
    const saved = expectOkPayload(calls.filter((call) => call.ok));
    expect(saved.file).toMatchObject({
      name: "vite.config.ts",
      kind: "modified",
      missing: false,
      size: Buffer.byteLength(content),
      hash: hashContent(content),
    });
    expect(Number.isInteger(saved.file.updatedAtMs)).toBe(true);
    expect(saved.file.content).toBeUndefined();
  });

  it("rejects oversized replacement content before allocating an encoded Buffer", async () => {
    const content = "é".repeat(128 * 1024 + 1);
    const bufferFrom = vi.spyOn(Buffer, "from");
    try {
      const error = expectError(
        await saveFile({
          path: "ui/vite.config.ts",
          content,
          expectedHash: hashContent("export default {};\n"),
        }),
      );

      expect(error.details).toMatchObject({
        maxPreviewBytes: 256 * 1024,
        path: "ui/vite.config.ts",
        size: 256 * 1024 + 2,
        type: "session_file_too_large",
      });
      expect(bufferFrom).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("round-trips a UTF-8 BOM through get and set", async () => {
    const original = "\uFEFFexport default {};\n";
    writeWorkspaceFile(workspaceRoot, "bom.ts", original);

    const preview = expectOkPayload(await getFile("bom.ts"));
    expect(preview.file.content).toBe(original);
    expect(preview.file.hash).toBe(hashContent(original));

    const next = "\uFEFFexport default { bom: true };\n";
    expectOkPayload(
      await saveFile({
        path: "bom.ts",
        content: next,
        expectedHash: preview.file.hash,
      }),
    );
    const bytes = fs.readFileSync(path.join(workspaceRoot, "bom.ts"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(next);
  });

  it("rejects replacement content containing NUL bytes", async () => {
    const error = expectError(
      await saveFile({
        path: "ui/vite.config.ts",
        content: "before\0after",
        expectedHash: hashContent("export default {};\n"),
      }),
    );

    expect(error.details).toMatchObject({
      path: "ui/vite.config.ts",
      type: "session_file_unsafe",
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "ui/vite.config.ts"), "utf8")).toBe(
      "export default {};\n",
    );
  });

  it("rejects writes to binary files even with a matching byte hash", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    fs.writeFileSync(path.join(workspaceRoot, "logo.png"), binary);

    const error = expectError(
      await saveFile({
        path: "logo.png",
        content: "text\n",
        expectedHash: createHash("sha256").update(binary).digest("hex"),
      }),
    );

    expect(error.details).toMatchObject({
      path: "logo.png",
      type: "session_file_unsafe",
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "logo.png"))).toEqual(binary);
  });

  it("registers session assets and rejects more than 64 references before loading files", async () => {
    const empty = expectOkPayload(
      await invoke("sessions.files.assets", {
        sessionKey,
        path: "index.html",
        refs: [],
      }),
    );
    expect(empty).toEqual({ assets: [] });
    hoisted.loadSessionEntry.mockClear();
    const error = expectError(
      await invoke("sessions.files.assets", {
        sessionKey,
        path: "index.html",
        refs: Array.from({ length: 65 }, (_, index) => `image-${index}.png`),
      }),
    );
    expect(error.code).toBe("INVALID_REQUEST");
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
  });
});

describe("sessions.files preview formats", () => {
  const remoteDirs = useAutoCleanupTempDirTracker(afterEach);
  let releaseRemote: (() => void) | undefined;

  afterEach(() => {
    releaseRemote?.();
    releaseRemote = undefined;
  });

  it("browses and previews the workspace owner's files without exposing a local copy or unsafe edits", async () => {
    const remote = remoteDirs.make("session-remote-preview-");
    fs.writeFileSync(path.join(workspaceRoot, "result.json"), "Gateway decoy");
    fs.symlinkSync("result.json", path.join(remote, "result-link.json"));
    fs.writeFileSync(path.join(remote, "result.json"), '{"total":46}');
    fs.writeFileSync(path.join(remote, "large.txt"), "x".repeat(256 * 1024 + 1));
    const owner = await openSafeRoot(remote, { symlinks: "reject" });
    let includeFileTypes = true;
    let denyLegacyChild = false;
    const ownerPath = (filePath: string) => path.relative(workspaceRoot, filePath);
    const readFile = vi.fn(
      async ({ filePath, maxBytes }: { filePath: string; maxBytes?: number }) =>
        (await owner.read(ownerPath(filePath), { maxBytes })).buffer,
    );
    releaseRemote = registerAgentWorkspaceAccess(workspaceRoot, {
      bridge: {
        readFile,
        writeFile: async () => {
          throw new Error("Unexpected non-CAS write");
        },
        stat: async ({ filePath }) => {
          if (denyLegacyChild && ownerPath(filePath) === "result.json") {
            throw Object.assign(new Error("node denied file stat"), { code: "PERMISSION_DENIED" });
          }
          const stat = fs.lstatSync(path.join(remote, ownerPath(filePath)), {
            throwIfNoEntry: false,
          });
          if (!stat) {
            return null;
          }
          if (stat.isSymbolicLink()) {
            throw Object.assign(new Error("node rejected symlink"), { code: "SYMLINK_REDIRECT" });
          }
          return {
            type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        },
        readDirectory: async ({ filePath }) =>
          (await owner.list(ownerPath(filePath), { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory,
            isFile: includeFileTypes ? entry.isFile : undefined,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })),
      },
    });
    const payload = expectOkPayload(await getFile("result.json"));
    expect(payload.file).toMatchObject({
      content: '{"total":46}',
      previewKind: "text",
      missing: false,
    });
    expect(payload.file.hash).toBeUndefined();
    const listed = expectOkPayload(await listFiles());
    expect(listed.browser.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "large.txt",
      "result.json",
    ]);
    expect(listed.gitCheckout).toBeUndefined();
    includeFileTypes = false;
    // Older nodes reject symlink stats instead of returning a file type.
    const legacyListing = expectOkPayload(await listFiles());
    expect(legacyListing.browser.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "large.txt",
      "result.json",
    ]);
    denyLegacyChild = true;
    await expect(
      invoke("sessions.files.list", {
        sessionKey,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    denyLegacyChild = false;
    const reveal = expectOkPayload(
      await invoke("sessions.files.reveal", {
        key: sessionKey,
      }),
    );
    expect(reveal).toMatchObject({ ok: false, error: expect.stringContaining("remote host") });
    expect(expectError(await getFile("large.txt")).details.type).toBe("session_file_too_large");
    expect(readFile).toHaveBeenCalledTimes(1);
    await expect(
      invoke("sessions.files.set", {
        sessionKey,
        path: "result.json",
        content: "changed",
        expectedHash: hashContent('{"total":46}'),
      }),
    ).rejects.toThrow("conflict-safe editing");
    expect(fs.readFileSync(path.join(workspaceRoot, "result.json"), "utf8")).toBe("Gateway decoy");
    releaseRemote();
    await expect(getFile("result.json")).rejects.toThrow("stopped or not ready");
  });

  it("reports the preview limit when a remote file grows between stat and fetch", async () => {
    releaseRemote = registerAgentWorkspaceAccess(workspaceRoot, {
      bridge: {
        stat: async () => ({ type: "file", size: 14, mtimeMs: 1 }),
        readFile: async () => {
          throw Object.assign(new Error("node refused oversized file"), { code: "FILE_TOO_LARGE" });
        },
        writeFile: async () => {
          throw new Error("unexpected write");
        },
      },
    });
    const result = await getFile("growing.txt");
    expect(expectError(result).details.type).toBe("session_file_too_large");
  });

  it.each(TEXT_PREVIEW_FIXTURES)("keeps detected $format text editable", async (fixture) => {
    const fileName = `detected-${fixture.format.toLowerCase().replaceAll(" ", "-")}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.content, "utf8");
    const payload = expectOkPayload(await getFile(fileName));
    expect(payload.file).toMatchObject({
      content: fixture.content,
      contentEncoding: "utf8",
      hash: hashContent(fixture.content),
      mimeType: fixture.mimeType,
      path: fileName,
      previewKind: "text",
    });
  });
});

describe("sessions.files touched-file folds", () => {
  function page(
    cursor: string,
    events: ReturnType<typeof visibleMessageEvent>[] = [],
    hasMore = false,
  ) {
    return { kind: "page", cursor, events, hasMore, serializedBytes: 100 };
  }
  const listTouched = async () => expectOkPayload(await listFiles());
  const touchedKinds = (payload: Record<string, unknown>[]) =>
    payload.map((file) => [file.path, file.kind]);

  it("retains incremental cursors across more than 16 concurrently viewed sessions", async () => {
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(undefined);
    const storePath = path.join(workspaceRoot, "visible-sessions.sqlite");
    hoisted.loadSessionEntry.mockImplementation((key: string) => {
      const sessionId = key.split(":").at(-1)!;
      return {
        agentId: "main",
        canonicalKey: key,
        cfg: {},
        storePath,
        entry: { sessionId, sessionFile: `sqlite:main:${sessionId}:${storePath}` },
      };
    });
    hoisted.readDelta.mockImplementation((scope) => page(`${scope.sessionId}-cursor`, [], false));

    const sessionKeys = Array.from({ length: 24 }, (_, index) => `agent:main:visible-${index}`);
    for (const key of sessionKeys) {
      expectOkPayload(await invoke("sessions.files.list", { sessionKey: key }));
    }
    expectOkPayload(await invoke("sessions.files.list", { sessionKey: sessionKeys[0] }));

    expect(hoisted.readDelta.mock.lastCall?.[1]).toMatchObject({
      cursor: "visible-0-cursor",
    });
  });

  it("yields between SQLite pages and shares one concurrent fold per session", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-singleflight");
    const firstPageRead = createDeferred();
    let otherWorkRan = false;
    setImmediate(() => {
      otherWorkRan = true;
    });
    hoisted.readDelta.mockImplementation((_scope, limits) => {
      if (limits.cursor !== undefined) {
        expect(limits.cursor).toBe("singleflight-page-1");
        expect(otherWorkRan).toBe(true);
      } else {
        firstPageRead.resolve();
      }
      return page(
        limits.cursor === undefined ? "singleflight-page-1" : "singleflight-final",
        [],
        limits.cursor === undefined,
      );
    });

    const params = { sessionKey };
    const first = invoke("sessions.files.list", params);
    const second = invoke("sessions.files.list", params);

    await firstPageRead.promise;
    expect(hoisted.readDelta).toHaveBeenCalledTimes(1);
    for (const result of await Promise.all([first, second])) {
      expectOkPayload(result);
    }
    expect(hoisted.readDelta).toHaveBeenCalledTimes(2);
  });

  it("isolates touched-file folds for the same session across stores", async () => {
    const sessionId = "sess-touched-multi-store";
    const firstStorePath = path.join(workspaceRoot, "store-a.sqlite");
    const secondStorePath = path.join(workspaceRoot, "store-b.sqlite");
    hoisted.readDelta.mockImplementation((scope, limits) => {
      expect(limits.cursor).toBeUndefined();
      const message =
        scope.storePath === firstStorePath
          ? assistantToolCall("read", { path: "src/readme.md" })
          : assistantToolCall("edit", { path: "ui/chat.ts" });
      return page(`${scope.storePath}-final`, [visibleMessageEvent(message, 1)], false);
    });

    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, firstStorePath);
    const first = await listTouched();
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, secondStorePath);
    const second = await listTouched();

    expect(first.files).toEqual([expect.objectContaining({ path: "src/readme.md", kind: "read" })]);
    expect(second.files).toEqual([
      expect.objectContaining({ path: "ui/chat.ts", kind: "modified" }),
    ]);
  });

  it("rebuilds the SQLite fold from the bootstrap cursor after a reset", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-reset");
    hoisted.readDelta.mockImplementation((_scope, limits) => {
      if (limits.cursor === undefined) {
        return page(
          "generation-1",
          [visibleMessageEvent(assistantToolCall("read", { path: "src/readme.md" }), 1)],
          false,
        );
      }
      if (limits.cursor === "generation-1") {
        return {
          kind: "reset",
          cursor: "generation-2-bootstrap",
          reason: "generation_mismatch",
        };
      }
      if (limits.cursor === "generation-2-bootstrap") {
        return page(
          "generation-2-final",
          [visibleMessageEvent(assistantToolCall("edit", { path: "ui/chat.ts" }), 1)],
          false,
        );
      }
      throw new Error(`unexpected cursor: ${String(limits.cursor)}`);
    });

    const beforeReset = await listTouched();
    const afterReset = await listTouched();

    expect(beforeReset.files).toEqual([
      expect.objectContaining({ path: "src/readme.md", kind: "read" }),
    ]);
    expect(afterReset.files).toEqual([
      expect.objectContaining({ path: "ui/chat.ts", kind: "modified" }),
    ]);
    expect(hoisted.readDelta).toHaveBeenCalledTimes(3);
  });

  it("collects touched files from existing transcript tool-call spellings", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-spellings");
    mockVisibleMessages([
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: { path: "src/readme.md" } },
          { type: "toolcall", name: "edit", arguments: { path: "ui/vite.config.ts" } },
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
    ]);

    const payload = await listTouched();

    expect(touchedKinds(payload.files)).toEqual([
      ["package.json", "modified"],
      ["ui/vite.config.ts", "modified"],
      ["src/readme.md", "read"],
      ["ui/chat.ts", "read"],
    ]);
  });

  it("collects changed files from structured apply_patch changes", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-structured-patch");
    mockVisibleMessages([
      assistantToolCall("apply_patch", {
        changes: [
          { path: "ui/chat.ts", kind: "update" },
          { path: "src/readme.md", kind: "delete" },
          { path: "old-name.md", kind: { type: "update", move_path: "package.json" } },
        ],
      }),
    ]);

    const payload = await listTouched();

    expect(touchedKinds(payload.files)).toEqual([
      ["old-name.md", "modified"],
      ["package.json", "modified"],
      ["src/readme.md", "modified"],
      ["ui/chat.ts", "modified"],
    ]);
  });

  it("omits transcript paths outside the workspace without hiding missing workspace files", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-outside-paths");
    const outsidePath = outsideFile();
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    mockVisibleMessages(
      [
        outsidePath,
        "../outside.txt",
        "~/.openclaw-external.txt",
        pathToFileURL(outsidePath).href,
        `@${outsidePath}`,
        "..cache/missing.txt",
        "missing.txt",
        "src/readme.md",
      ].map((filePath) => assistantToolCall("read", { path: filePath })),
    );

    const payload = await listTouched();

    expect(payload.files).toHaveLength(3);
    expect(payload.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "..cache/missing.txt", missing: true }),
        expect.objectContaining({ path: "missing.txt", missing: true }),
        expect.objectContaining({
          path: "src/readme.md",
          missing: false,
          workspacePath: "src/readme.md",
        }),
      ]),
    );
  });
});
