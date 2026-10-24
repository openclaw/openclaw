import "./sessions-files.mocks.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as identityFile from "../../agents/identity-file.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { root as openSafeRoot } from "../../infra/fs-safe.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveOpenPathCommand } from "./open-path.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  TEXT_PREVIEW_FIXTURES,
  useSqliteSession,
  visibleMessageEvent,
  createSessionFilesHandlerInvoker,
  createSessionFilesClient,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";

const { sessionFilesMocks } = await import("./sessions-files.mocks.test-support.js");

const openPathMocks = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
}));
const hoisted = { ...sessionFilesMocks, ...openPathMocks };

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: openPathMocks.execOpenPath };
});

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const files = createSessionFilesClient(invoke, () => ({ sessionKey }));
const saveFile = (
  name: string,
  content: string,
  original: string | Buffer,
  context?: Record<string, unknown>,
) =>
  files.request(
    "set",
    {
      path: name,
      content,
      expectedHash: createHash("sha256").update(original).digest("hex"),
    },
    context,
  );
const workspacePath = (...parts: string[]) => path.join(workspaceRoot, ...parts);
const readWorkspace = (...parts: string[]) => fs.readFileSync(workspacePath(...parts), "utf8");
const writeWorkspace = (name: string, content: string) =>
  writeWorkspaceFile(workspaceRoot, name, content);
async function expectFile(name: string, expected: Record<string, unknown>) {
  expect((await files.ok("get", name)).file).toMatchObject(expected);
}
const expectText = (name: string, content: string, extra: Record<string, unknown> = {}) =>
  expectFile(name, {
    content,
    contentEncoding: "utf8",
    hash: hashContent(content),
    mimeType: "text/plain",
    path: name,
    previewKind: "text",
    ...extra,
  });
const browserKinds = (entries: Record<string, unknown>[]) =>
  entries.map((entry) => [entry.path, entry.kind, entry.sessionKind]);

const outsideDirs = useAutoCleanupTempDirTracker(afterEach);
const outsideFile = () => path.join(outsideDirs.make("session-files-outside-"), "outside.txt");

const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files RPC handlers", () => {
  function mockSession(
    entry: Record<string, unknown>,
    agentId = "main",
    storePath = workspacePath(".sessions.json"),
  ) {
    hoisted.loadSessionEntry.mockReturnValue({
      agentId,
      canonicalKey: `agent:${agentId}:main`,
      cfg: {},
      storePath,
      entry,
    });
  }

  it.each(["list", "get", "assets", "set", "reveal"] as const)(
    "rejects device-folder %s without touching either host's files",
    async (operation) => {
      const deviceRoot = outsideDirs.make("session-files-device-");
      fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "GATEWAY");
      fs.writeFileSync(path.join(deviceRoot, "notes.txt"), "DEVICE");
      mockSession({
        sessionId: "device-session",
        deviceFolder: { deviceId: "paired-device", path: deviceRoot },
        spawnedCwd: workspaceRoot,
        spawnedWorkspaceDir: workspaceRoot,
      });
      const params =
        operation === "reveal"
          ? { key: sessionKey }
          : {
              sessionKey,
              path: "notes.txt",
              ...(operation === "assets" ? { refs: [] } : {}),
              ...(operation === "set"
                ? { content: "WRONG HOST", expectedHash: hashContent("GATEWAY") }
                : {}),
            };
      const error = await files.error(operation, params);
      expect(error.details).toMatchObject({ type: "device_folder_files_unavailable" });
      expect(readWorkspace("notes.txt")).toBe("GATEWAY");
      expect(fs.readFileSync(path.join(deviceRoot, "notes.txt"), "utf8")).toBe("DEVICE");
      expect(hoisted.execOpenPath).not.toHaveBeenCalled();
      expect(hoisted.readDelta).not.toHaveBeenCalled();
    },
  );

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
    const listPayload = await files.ok("list");
    const revealPayload = await files.ok("reveal");

    expect(revealPayload).toEqual({ ok: true, path: listPayload.root });
    expect(hoisted.execOpenPath).toHaveBeenCalledWith(
      resolveOpenPathCommand(listPayload.root as string),
    );
  });

  it("returns no workspace listing while the session checkout is pending", async () => {
    mockSession({ sessionId: "sess-pending", pendingWorktree: { titleSource: "New checkout" } });
    mockVisibleMessages([]);

    expect(await files.ok("list")).toEqual({
      sessionKey,
      files: [],
    });
  });

  it("uses the persisted fixed-store owner for a bare session workspace", async () => {
    const cfg = fixedStoreConfig();
    setRuntimeConfigSnapshot(cfg);
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

    const payload = await files.ok(
      "list",
      { sessionKey: "global" },
      { getRuntimeConfig: () => cfg },
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
    setRuntimeConfigSnapshot(cfg);

    const error = await files.error(
      "set",
      {
        sessionKey: "global",
        agentId: "research",
        path: "ui/chat.ts",
        content: "foreign write\n",
        expectedHash: hashContent("export const chat = true;\n"),
      },
      { getRuntimeConfig: () => cfg },
    );

    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'agent "research" does not match session key agent "ops"',
    });
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
    expect(readWorkspace("ui/chat.ts")).toBe("export const chat = true;\n");
  });

  it.each(["runs remotely", "exec node", "No workspace root"])(
    "refuses to reveal: %s",
    async (reason) => {
      if (reason === "No workspace root") {
        hoisted.resolveAgentWorkspaceDir.mockReturnValue(undefined);
        mockSession({ sessionId: "sess-main", sessionFile: "sess-main.jsonl" });
      } else if (reason === "exec node") {
        mockSession({ sessionId: "sess-main", spawnedCwd: workspaceRoot, execNode: "build-mac" });
      }
      const context =
        reason === "runs remotely"
          ? {
              workerSessionPlacementService: {
                getMany: () => new Map([["sess-main", { state: "active" }]]),
              },
            }
          : {};
      const payload = await files.ok("reveal", {}, context);
      if (reason === "No workspace root") {
        expect(payload).toEqual({
          ok: false,
          error: "No workspace root is available for this session.",
        });
      } else {
        expect(payload).toMatchObject({
          ok: false,
          path: workspaceRoot,
          error: expect.stringContaining(reason),
        });
      }
      expect(hoisted.execOpenPath).not.toHaveBeenCalled();
    },
  );

  it("returns opener failures as successful RPC results", async () => {
    const warn = vi.fn();
    hoisted.execOpenPath.mockRejectedValueOnce(new Error("xdg-open: no method available"));

    const payload = await files.ok("reveal", {}, { logGateway: { warn } });

    expect(payload).toMatchObject({
      ok: false,
      path: workspaceRoot,
      error: expect.stringContaining("headless environment"),
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sessions.files.reveal failed path="),
    );
  });

  it("prefers the spawned workspace root over a nested spawned cwd", async () => {
    const nestedCwd = workspacePath("packages/app");
    writeWorkspace("packages/app/src/readme.md", "# Nested read me\n");
    writeWorkspace("packages/shared/config.ts", "export const shared = true;\n");
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

    const payload = await files.ok("list");

    expect(payload).toMatchObject({
      root: workspaceRoot,
      files: [
        { missing: false, path: "../shared/config.ts" },
        { missing: false, path: "src/readme.md" },
      ],
    });
    expect(browserKinds(payload.browser.entries)).toEqual([
      ["packages", "directory", "read"],
      ["src", "directory", undefined],
      ["ui", "directory", undefined],
      ["package.json", "file", undefined],
    ]);

    const nested = { content: "# Nested read me\n", workspacePath: "packages/app/src/readme.md" };
    const root = { content: "# Read me\n", workspacePath: "src/readme.md" };
    const shared = { content: "export const shared = true;\n" };
    for (const [name, expected] of [
      ["src/readme.md", nested],
      [workspacePath("src/readme.md"), root],
      ["packages/app/src/readme.md", { content: nested.content }],
      ["packages//app/src/readme.md", { workspacePath: nested.workspacePath }],
      ["../shared/config.ts", shared],
      ["packages/shared/config.ts", shared],
    ] as const) {
      await expectFile(name, expected);
    }
  });

  it("round-trips listed folders beginning with two dots", async () => {
    writeWorkspace("..notes/readme.md", "# Notes\n");
    const root = await files.ok("list");
    const selected = root.browser.entries.find(
      (entry: Record<string, unknown>) => entry.name === "..notes",
    );
    const folder = await files.ok("list", { path: selected.path });
    expect(folder.browser).toMatchObject({
      path: "..notes",
      parentPath: "",
      entries: [{ path: "..notes/readme.md", kind: "file" }],
    });
    await expectFile(folder.browser.entries[0].path, { content: "# Notes\n" });
  });

  it("browses, searches, and previews files not referenced by the session", async () => {
    const folderPayload = await files.ok("list", { path: "ui" });

    expect(folderPayload.browser.parentPath).toBe("");
    expect(browserKinds(folderPayload.browser.entries)).toEqual([
      ["ui/chat.ts", "file", "modified"],
      ["ui/vite.config.ts", "file", undefined],
    ]);

    const searchPayload = await files.ok("list", { search: "vite" });

    expect(searchPayload.browser).toMatchObject({
      search: "vite",
      entries: [{ path: "ui/vite.config.ts" }],
    });
    await expectText("ui/vite.config.ts", "export default {};\n", { kind: "read", missing: false });
  });

  it("truncates broad workspace searches by visited entries, not only by matches", async () => {
    for (let index = 0; index < 5_025; index += 1) {
      writeWorkspace(`bulk-${String(index).padStart(4, "0")}.txt`, "");
    }
    writeWorkspace("zz-tail-needle.ts", "");

    const payload = await files.ok("list", { search: "needle" });

    expect(payload.browser).toMatchObject({ search: "needle", truncated: true, entries: [] });
  });

  it("marks searches incomplete when an excluded directory may hide a match", async () => {
    writeWorkspace("src/REPORT.md", "# Source report\n");
    writeWorkspace("dist/REPORT.md", "# Generated report\n");

    const payload = await files.ok("list", { search: "REPORT.md" });

    expect(payload.browser).toMatchObject({
      search: "REPORT.md",
      truncated: true,
      entries: [{ path: "src/REPORT.md" }],
    });
  });

  it("keeps searches complete when only repository metadata is excluded", async () => {
    writeWorkspace("src/REPORT.md", "# Source report\n");
    writeWorkspace(".git/objects/REPORT.md", "# Git object\n");

    const payload = await files.ok("list", { search: "REPORT.md" });

    expect(payload.browser).toMatchObject({
      search: "REPORT.md",
      entries: [{ path: "src/REPORT.md" }],
    });
    expect(payload.browser).not.toHaveProperty("truncated");
  });

  it.runIf(process.platform === "linux")(
    "reports non-UTF-8 filenames during workspace browse",
    async () => {
      const invalidPath = Buffer.concat([
        Buffer.from(path.join(workspaceRoot, "ui") + path.sep),
        Buffer.from([0xff]),
      ]);
      fs.writeFileSync(invalidPath, "unaddressable file");

      await expect(files.request("list", { path: "ui" })).rejects.toMatchObject({
        code: "invalid-path",
        message: 'Cannot list workspace directory "ui": directory entry name is not valid UTF-8',
      });
      expect(readWorkspace("ui/vite.config.ts")).toBe("export default {};\n");
      expect(fs.readFileSync(invalidPath, "utf8")).toBe("unaddressable file");
    },
  );

  it("does not follow symlinked parent directories for file previews", async () => {
    const outsideDir = outsideDirs.make("session-files-parent-");
    writeWorkspaceFile(outsideDir, "secret.txt", "linked parent outside\n");
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, "linked-dir"), "dir");

    const error = await files.error("get", "linked-dir/secret.txt");

    expect(error.details).toMatchObject({
      path: "linked-dir/secret.txt",
      type: "session_file_not_found",
    });
  });

  it("does not browse paths outside the session workspace root", async () => {
    const payload = await files.ok("list", { path: "../" });

    expect(payload.root).toBe(workspaceRoot);
    expect(payload.browser).toBeUndefined();
  });

  it("does not derive a workspace root from transcript cwd", async () => {
    const sessionsDir = path.join(workspaceRoot, "custom-sessions");
    const transcriptCwd = outsideDirs.make("session-files-transcript-");
    writeWorkspaceFile(transcriptCwd, "secret.txt", "transcript cwd secret\n");
    writeWorkspace(
      "custom-sessions/sess-main.jsonl",
      `${JSON.stringify({ cwd: transcriptCwd })}\n`,
    );
    mockSession(
      { sessionId: "sess-main", sessionFile: "sess-main.jsonl" },
      "main",
      path.join(sessionsDir, "sessions.json"),
    );
    mockVisibleMessages([assistantToolCall("read", { path: "secret.txt" })]);
    const listPayload = await files.ok("list");

    expect(listPayload.root).toBe(workspaceRoot);
    expect(listPayload.browser).toBeDefined();
    expect(listPayload.files).toMatchObject([{ missing: true, path: "secret.txt" }]);

    const error = await files.error("get", "secret.txt");
    expect(error.details).toMatchObject({ path: "secret.txt", type: "session_file_not_found" });
  });

  it("refreshes committed identity bytes after a pending pre-write read", async () => {
    const identityPath = workspacePath("IDENTITY.md");
    const original = "- Name: Before\n";
    const replacement = "- Name: After\n";
    writeWorkspace("IDENTITY.md", original);
    const captured = createDeferred();
    const release = createDeferred();
    const joined = createDeferred();
    let firstRead = true;
    const worker = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async () => {
      const snapshot = identityFile.readIdentityFileSnapshot({ identityPath });
      if (firstRead) {
        firstRead = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    });
    const loadIdentity = identityFile.loadAgentIdentityFromWorkspaceAsync;
    let identityLoads = 0;
    const load = vi
      .spyOn(identityFile, "loadAgentIdentityFromWorkspaceAsync")
      .mockImplementation((workspace) => {
        const pending = loadIdentity(workspace);
        if (++identityLoads === 2) {
          joined.resolve();
        }
        return pending;
      });
    const staleRead = identityFile.loadAgentIdentityFromWorkspaceAsync(workspaceRoot);
    let publication: Promise<identityFile.AgentIdentityFile | null> | undefined;
    const broadcast = vi.fn(() => {
      publication = identityFile.loadAgentIdentityFromWorkspaceAsync(workspaceRoot);
    });
    let save: ReturnType<typeof invoke> | undefined;
    try {
      await awaitGateBeforeSettlement(captured.promise, staleRead, "identity read was not started");
      save = saveFile(identityPath, replacement, original, { broadcast });
      await awaitGateBeforeSettlement(joined.promise, save, "identity read was not joined");
      expect(fs.readFileSync(identityPath, "utf8")).toBe(replacement);
      expect(broadcast).not.toHaveBeenCalled();
      release.resolve();
      expectOkPayload(await save);
      expect(broadcast).toHaveBeenCalledExactlyOnceWith("agent.identity.changed", {
        agentId: "main",
      });
      expect(await staleRead).toEqual({ name: "Before" });
      expect(await publication).toEqual({ name: "After" });
    } finally {
      release.resolve();
      await Promise.allSettled([staleRead, ...(save ? [save] : [])]);
      load.mockRestore();
      worker.mockRestore();
    }
  });

  it.each(["nested", "project", "conflict"] as const)(
    "does not invalidate agent identity for a %s file save",
    async (variant) => {
      const name = variant === "nested" ? "ui/IDENTITY.md" : "IDENTITY.md";
      const original = "- Name: Before\n";
      writeWorkspace(name, original);
      if (variant === "project") {
        hoisted.resolveAgentWorkspaceDir.mockReturnValue(workspacePath("agent"));
      }
      const broadcast = vi.fn();
      const calls = await saveFile(
        name,
        "- Name: After\n",
        variant === "conflict" ? "stale" : original,
        { broadcast },
      );
      if (variant === "conflict") {
        expect(expectError(calls).details.type).toBe("session_file_conflict");
        expect(readWorkspace(name)).toBe(original);
      } else {
        expectOkPayload(calls);
        expect(readWorkspace(name)).toBe("- Name: After\n");
      }
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("allows only one concurrent save across nested workspace aliases", async () => {
    const original = "export default {};\n";
    const firstSession = hoisted.loadSessionEntry();
    const nestedKey = "agent:main:nested";
    const nestedSession = {
      ...firstSession,
      canonicalKey: nestedKey,
      entry: { ...firstSession.entry, sessionId: "nested", spawnedCwd: workspacePath("ui") },
    };
    hoisted.loadSessionEntry.mockImplementation((key: string) =>
      key === nestedKey ? nestedSession : firstSession,
    );
    const [first, second] = await Promise.all([
      saveFile("ui/vite.config.ts", "export default { first: true };\n", original),
      files.request("set", {
        sessionKey: nestedKey,
        path: "./vite.config.ts",
        content: "export default { second: true };\n",
        expectedHash: hashContent(original),
      }),
    ]);

    const calls = [...first, ...second];
    expect(calls.filter((call) => call?.ok)).toHaveLength(1);
    const conflict = expectError(calls.filter((call) => !call.ok));
    expect(conflict.details).toMatchObject({ type: "session_file_conflict" });
    const content = readWorkspace("ui/vite.config.ts");
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
        await saveFile("ui/vite.config.ts", content, "export default {};\n"),
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

    const preview = await files.ok("get", "bom.ts");
    expect(preview.file.content).toBe(original);
    expect(preview.file.hash).toBe(hashContent(original));

    const next = "\uFEFFexport default { bom: true };\n";
    await files.ok("set", {
      path: "bom.ts",
      content: next,
      expectedHash: preview.file.hash,
    });
    const bytes = fs.readFileSync(path.join(workspaceRoot, "bom.ts"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(next);
  });

  it.each([
    ["NUL replacement", "ui/vite.config.ts", "before\0after", "export default {};\n"],
    [
      "binary target",
      "logo.png",
      "text\n",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    ],
  ] as const)(
    "rejects an unsafe %s without changing the file",
    async (_label, name, content, original) => {
      fs.writeFileSync(workspacePath(name), original);
      const error = expectError(await saveFile(name, content, original));
      expect(error.details).toMatchObject({ path: name, type: "session_file_unsafe" });
      expect(fs.readFileSync(workspacePath(name))).toEqual(Buffer.from(original));
    },
  );

  it("registers session assets and rejects more than 64 references before loading files", async () => {
    const empty = await files.ok("assets", { path: "index.html", refs: [] });
    expect(empty).toEqual({ assets: [] });
    hoisted.loadSessionEntry.mockClear();
    const error = await files.error("assets", {
      path: "index.html",
      refs: Array.from({ length: 65 }, (_, index) => `image-${index}.png`),
    });
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
    const payload = await files.ok("get", "result.json");
    expect(payload.file).toMatchObject({
      content: '{"total":46}',
      previewKind: "text",
      missing: false,
    });
    expect(payload.file.hash).toBeUndefined();
    // Older nodes omit file types and reject symlink stats.
    for (includeFileTypes of [true, false]) {
      const listed = await files.ok("list");
      expect(listed.browser.entries.map((entry: { name: string }) => entry.name)).toEqual([
        "large.txt",
        "result.json",
      ]);
      expect(listed.gitCheckout).toBeUndefined();
    }
    denyLegacyChild = true;
    await expect(files.request("list")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    denyLegacyChild = false;
    const reveal = await files.ok("reveal");
    expect(reveal).toMatchObject({ ok: false, error: expect.stringContaining("remote host") });
    expect((await files.error("get", "large.txt")).details.type).toBe("session_file_too_large");
    expect(readFile).toHaveBeenCalledTimes(1);
    await expect(saveFile("result.json", "changed", '{"total":46}')).rejects.toThrow(
      "conflict-safe editing",
    );
    expect(readWorkspace("result.json")).toBe("Gateway decoy");
    releaseRemote();
    await expect(files.request("get", "result.json")).rejects.toThrow("stopped or not ready");
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
    const result = await files.request("get", "growing.txt");
    expect(expectError(result).details.type).toBe("session_file_too_large");
  });

  it.each(TEXT_PREVIEW_FIXTURES)("keeps detected $format text editable", async (fixture) => {
    const fileName = `detected-${fixture.format.toLowerCase().replaceAll(" ", "-")}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.content, "utf8");
    await expectText(fileName, fixture.content, { mimeType: fixture.mimeType });
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
  const listTouched = () => files.ok("list");
  const touchedKinds = (payload: Record<string, unknown>[]) =>
    payload.map((file) => [file.path, file.kind]);
  const toolPage = (cursor: string, name: string, filePath: string) =>
    page(cursor, [visibleMessageEvent(assistantToolCall(name, { path: filePath }), 1)]);

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

    const first = files.request("list");
    const second = files.request("list");

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
      return scope.storePath === firstStorePath
        ? toolPage("store-a-final", "read", "src/readme.md")
        : toolPage("store-b-final", "edit", "ui/chat.ts");
    });

    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, firstStorePath);
    const first = await listTouched();
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, secondStorePath);
    const second = await listTouched();

    expect(touchedKinds(first.files)).toEqual([["src/readme.md", "read"]]);
    expect(touchedKinds(second.files)).toEqual([["ui/chat.ts", "modified"]]);
  });

  it("rebuilds the SQLite fold from the bootstrap cursor after a reset", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-reset");
    hoisted.readDelta.mockImplementation((_scope, limits) => {
      if (limits.cursor === undefined) {
        return toolPage("generation-1", "read", "src/readme.md");
      }
      if (limits.cursor === "generation-1") {
        return { kind: "reset", cursor: "generation-2-bootstrap", reason: "generation_mismatch" };
      }
      if (limits.cursor === "generation-2-bootstrap") {
        return toolPage("generation-2-final", "edit", "ui/chat.ts");
      }
      throw new Error(`unexpected cursor: ${String(limits.cursor)}`);
    });

    const beforeReset = await listTouched();
    const afterReset = await listTouched();

    expect(touchedKinds(beforeReset.files)).toEqual([["src/readme.md", "read"]]);
    expect(touchedKinds(afterReset.files)).toEqual([["ui/chat.ts", "modified"]]);
    expect(hoisted.readDelta).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "existing transcript tool-call spellings",
      content: [
        { type: "tool_use", name: "read", input: { path: "src/readme.md" } },
        { type: "toolcall", name: "edit", arguments: { path: "ui/vite.config.ts" } },
        { type: "tool_use", name: "read", args: { path: "ui/chat.ts" } },
        {
          type: "tool_call",
          name: "apply_patch",
          input: { input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n" },
        },
      ],
      expected: [
        ["package.json", "modified"],
        ["ui/vite.config.ts", "modified"],
        ["src/readme.md", "read"],
        ["ui/chat.ts", "read"],
      ],
    },
    {
      name: "structured apply_patch changes",
      content: assistantToolCall("apply_patch", {
        changes: [
          { path: "ui/chat.ts", kind: "update" },
          { path: "src/readme.md", kind: "delete" },
          { path: "old-name.md", kind: { type: "update", move_path: "package.json" } },
        ],
      }).content,
      expected: [
        ["old-name.md", "modified"],
        ["package.json", "modified"],
        ["src/readme.md", "modified"],
        ["ui/chat.ts", "modified"],
      ],
    },
  ])("collects touched files from $name", async ({ content, expected }) => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-spellings");
    mockVisibleMessages([{ role: "assistant", content }]);
    expect(touchedKinds((await listTouched()).files)).toEqual(expected);
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
    for (const expected of [
      { path: "..cache/missing.txt", missing: true },
      { path: "missing.txt", missing: true },
      { path: "src/readme.md", missing: false, workspacePath: "src/readme.md" },
    ]) {
      expect(payload.files).toContainEqual(expect.objectContaining(expected));
    }
  });
});
