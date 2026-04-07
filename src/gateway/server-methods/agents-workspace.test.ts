import type { Dirent, Stats } from "node:fs";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

// Mock hoisted values
const mocks = vi.hoisted(() => ({
  // fs-safe mocks
  readFileWithinRoot: vi.fn(),
  writeFileWithinRoot: vi.fn(),
  mkdirPathWithinRoot: vi.fn(),
  removePathWithinRoot: vi.fn(),

  // fs/promises mocks
  fsReaddir: vi.fn(),
  fsStat: vi.fn(),
  fsLstat: vi.fn(),
  fsAccess: vi.fn(),
  fsMkdir: vi.fn(),
  fsRename: vi.fn(),
  fsRealpath: vi.fn((p: string) => Promise.resolve(p)),

  // config mock
  loadConfigReturn: {
    agents: {
      defaults: {
        workspace: "/tmp/test-workspace",
      },
    },
  },

  // agent-scope mock
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/test-workspace/main"),
}));

// Mock fs-safe functions
vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    readFileWithinRoot: mocks.readFileWithinRoot,
    writeFileWithinRoot: mocks.writeFileWithinRoot,
    mkdirPathWithinRoot: mocks.mkdirPathWithinRoot,
    removePathWithinRoot: mocks.removePathWithinRoot,
  };
});

// Mock fs/promises for directory operations
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    readdir: mocks.fsReaddir,
    stat: mocks.fsStat,
    lstat: mocks.fsLstat,
    access: mocks.fsAccess,
    mkdir: mocks.fsMkdir,
    rename: mocks.fsRename,
    realpath: mocks.fsRealpath,
  };
  return { ...patched, default: patched };
});

// Mock config
vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

// Mock agent-scope
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

// Mock session-key
vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
}));

// Import after mocks
const { agentsWorkspaceHandlers } = await import("./agents-workspace.js");
const { ErrorCodes } = await import("../protocol/index.js");

type RespondFn = (ok: boolean, result?: unknown, error?: unknown) => void;

function createRespondFn(): {
  respond: RespondFn;
  getLastCall: () => { ok: boolean; result: unknown; error: unknown } | null;
} {
  const calls: Array<{ ok: boolean; result: unknown; error: unknown }> = [];

  const respond: RespondFn = (ok, result, error) => {
    calls.push({ ok, result, error });
  };

  return {
    respond,
    getLastCall: () => calls[calls.length - 1] ?? null,
  };
}

function createContext() {
  return {
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
  };
}

// Helper to invoke workspace handlers
async function invokeWorkspaceHandler(
  method: keyof typeof agentsWorkspaceHandlers,
  params: Record<string, unknown>,
) {
  const { respond, getLastCall } = createRespondFn();
  const handler = agentsWorkspaceHandlers[method];

  await handler({
    params,
    respond: respond,
    context: createContext() as unknown as Parameters<typeof handler>[0]["context"],
    req: { type: "req", id: "test-req", method: method },
    client: null,
    isWebchatConnect: () => false,
  });

  return { respond, getLastCall };
}

describe("agents.workspace security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects path traversal attempts (../../../etc/passwd)", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "../../../etc/passwd",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("rejects paths with .. in the middle", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "documents/../secrets.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("rejects absolute paths", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "/etc/passwd",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("rejects paths starting with ..", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "../secrets.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("allows valid relative paths", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "documents/file.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
  });

  it("allows paths with ./ prefix (strips it)", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "./file.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
  });

  it("rejects path traversal in move 'from' parameter", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "../../../etc/passwd",
      to: "safe.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("rejects path traversal in move 'to' parameter", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "safe.txt",
      to: "../../../etc/passwd",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});

describe("agents.workspace.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists directory contents", async () => {
    mocks.fsReaddir.mockResolvedValue([
      { name: "file1.txt", isDirectory: () => false, isSymbolicLink: () => false },
      { name: "subdir", isDirectory: () => true, isSymbolicLink: () => false },
    ] as Dirent[]);

    mocks.fsStat.mockImplementation(async (filepath: string) => {
      const isFile = filepath.endsWith(".txt");
      return {
        isFile: () => isFile,
        size: isFile ? 100 : 0,
        mtimeMs: 1234567890,
        ctimeMs: 1234567800,
      } as unknown as Stats;
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "main",
      path: "",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect(
      (lastCall?.result as { entries?: Array<Record<string, unknown>> })?.entries,
    ).toHaveLength(2);
    expect((lastCall?.result as { entries?: Array<{ name: string }> })?.entries?.[0]?.name).toBe(
      "file1.txt",
    );
    expect((lastCall?.result as { entries?: Array<{ type: string }> })?.entries?.[0]?.type).toBe(
      "file",
    );
    expect((lastCall?.result as { entries?: Array<{ type: string }> })?.entries?.[1]?.type).toBe(
      "directory",
    );
  });

  it("lists directory contents recursively", async () => {
    let callCount = 0;
    mocks.fsReaddir.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { name: "subdir", isDirectory: () => true, isSymbolicLink: () => false },
        ] as Dirent[];
      }
      return [
        { name: "nested.txt", isDirectory: () => false, isSymbolicLink: () => false },
      ] as Dirent[];
    });

    mocks.fsStat.mockResolvedValue({
      isFile: () => true,
      size: 50,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "main",
      path: "",
      recursive: true,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect(
      (lastCall?.result as { entries?: Array<Record<string, unknown>> })?.entries?.length,
    ).toBeGreaterThan(0);
  });

  it("identifies symlinks correctly", async () => {
    mocks.fsReaddir.mockResolvedValue([
      { name: "link", isDirectory: () => false, isSymbolicLink: () => true },
    ] as Dirent[]);

    mocks.fsStat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => false,
      size: 0,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "main",
      path: "",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { entries?: Array<{ type: string }> })?.entries?.[0]?.type).toBe(
      "symlink",
    );
  });

  it("handles empty directories", async () => {
    mocks.fsReaddir.mockResolvedValue([] as Dirent[]);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "main",
      path: "",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { entries?: unknown[] })?.entries).toEqual([]);
  });

  it("returns error on internal errors", async () => {
    mocks.fsReaddir.mockRejectedValue(new Error("Permission denied"));

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "main",
      path: "",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.UNAVAILABLE);
  });
});

describe("agents.workspace.get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads file content as utf8", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("hello world"),
      stat: { size: 11, mtimeMs: 1234567890 } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "file.txt",
      encoding: "utf8",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { content?: string })?.content).toBe("hello world");
    expect((lastCall?.result as { size?: number })?.size).toBe(11);
  });

  it("reads file content as base64", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("hello world"),
      stat: { size: 11, mtimeMs: 1234567890 } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "file.txt",
      encoding: "base64",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { content?: string })?.content).toBe(
      Buffer.from("hello world").toString("base64"),
    );
  });

  it("defaults to utf8 encoding", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("hello world"),
      stat: { size: 11, mtimeMs: 1234567890 } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "file.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { encoding?: string })?.encoding).toBe("utf8");
  });

  it("handles file not found", async () => {
    mocks.readFileWithinRoot.mockRejectedValue(new Error("file not found"));

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "nonexistent.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.UNAVAILABLE);
  });
});

describe("agents.workspace.set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes file content as utf8", async () => {
    mocks.writeFileWithinRoot.mockResolvedValue(undefined);
    mocks.fsStat.mockResolvedValue({
      size: 11,
      mtimeMs: 1234567890,
    } as unknown as Stats);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.set", {
      agentId: "main",
      path: "file.txt",
      content: "hello world",
      encoding: "utf8",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { ok?: boolean })?.ok).toBe(true);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/tmp/test-workspace/main",
        relativePath: "file.txt",
        data: "hello world",
      }),
    );
  });

  it("writes file content as base64", async () => {
    mocks.writeFileWithinRoot.mockResolvedValue(undefined);
    mocks.fsStat.mockResolvedValue({
      size: 7,
      mtimeMs: 1234567890,
    } as unknown as Stats);

    const base64Content = Buffer.from("binary").toString("base64");
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.set", {
      agentId: "main",
      path: "file.bin",
      content: base64Content,
      encoding: "base64",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Buffer),
      }),
    );
  });

  it("creates directories when createDirs is true", async () => {
    mocks.writeFileWithinRoot.mockResolvedValue(undefined);
    mocks.fsStat.mockResolvedValue({
      size: 5,
      mtimeMs: 1234567890,
    } as unknown as Stats);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.set", {
      agentId: "main",
      path: "nested/dir/file.txt",
      content: "hello",
      createDirs: true,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        mkdir: true,
      }),
    );
  });

  it("rejects files exceeding size limit (10MB)", async () => {
    const largeContent = "x".repeat(11 * 1024 * 1024); // 11MB

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.set", {
      agentId: "main",
      path: "large.bin",
      content: largeContent,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect((lastCall?.error as { message?: string })?.message).toContain("exceeds size limit");
  });
});

describe("agents.workspace.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a file", async () => {
    mocks.fsStat.mockResolvedValue({
      isDirectory: () => false,
    } as unknown as Stats);

    mocks.removePathWithinRoot.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.delete", {
      agentId: "main",
      path: "file.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { deleted?: boolean })?.deleted).toBe(true);
  });

  it("deletes an empty directory", async () => {
    mocks.fsStat.mockResolvedValue({
      isDirectory: () => true,
    } as unknown as Stats);

    mocks.fsReaddir.mockResolvedValue([] as Dirent[]);
    mocks.removePathWithinRoot.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.delete", {
      agentId: "main",
      path: "empty-dir",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { deleted?: boolean })?.deleted).toBe(true);
  });

  it("rejects deleting non-empty directory without recursive flag", async () => {
    mocks.fsStat.mockResolvedValue({
      isDirectory: () => true,
    } as unknown as Stats);

    mocks.fsReaddir.mockResolvedValue([
      { name: "file.txt", isDirectory: () => false, isSymbolicLink: () => false },
    ] as Dirent[]);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.delete", {
      agentId: "main",
      path: "non-empty-dir",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { message?: string })?.message).toContain("not empty");
  });

  it("deletes non-empty directory with recursive flag", async () => {
    mocks.fsStat.mockResolvedValue({
      isDirectory: () => true,
    } as unknown as Stats);

    mocks.fsReaddir.mockResolvedValue([
      { name: "file.txt", isDirectory: () => false, isSymbolicLink: () => false },
    ] as Dirent[]);

    mocks.removePathWithinRoot.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.delete", {
      agentId: "main",
      path: "non-empty-dir",
      recursive: true,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { deleted?: boolean })?.deleted).toBe(true);
  });

  it("returns deleted: false when file does not exist", async () => {
    const error = new Error("file not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    mocks.removePathWithinRoot.mockRejectedValue(error);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.delete", {
      agentId: "main",
      path: "nonexistent.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { deleted?: boolean })?.deleted).toBe(false);
  });
});

describe("agents.workspace.mkdir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a directory", async () => {
    mocks.mkdirPathWithinRoot.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.mkdir", {
      agentId: "main",
      path: "new-dir",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { created?: boolean })?.created).toBe(true);
    expect(mocks.mkdirPathWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/tmp/test-workspace/main",
        relativePath: "new-dir",
      }),
    );
  });

  it("returns created: false when directory already exists", async () => {
    const error = new Error("directory exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    mocks.mkdirPathWithinRoot.mockRejectedValue(error);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.mkdir", {
      agentId: "main",
      path: "existing-dir",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { created?: boolean })?.created).toBe(false);
  });

  it("creates parent directories with parents flag", async () => {
    mocks.mkdirPathWithinRoot.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.mkdir", {
      agentId: "main",
      path: "nested/dir/path",
      parents: true,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { created?: boolean })?.created).toBe(true);
  });
});

describe("agents.workspace.move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves a file", async () => {
    mocks.fsAccess.mockResolvedValue(undefined);
    mocks.fsAccess.mockRejectedValueOnce(new Error("not found"));
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "old.txt",
      to: "new.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { ok?: boolean })?.ok).toBe(true);
    expect(mocks.fsRename).toHaveBeenCalled();
  });

  it("renames a file within the same directory", async () => {
    mocks.fsAccess.mockResolvedValue(undefined);
    mocks.fsAccess.mockRejectedValueOnce(new Error("not found"));
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "dir/old-name.txt",
      to: "dir/new-name.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
  });

  it("rejects when source does not exist", async () => {
    mocks.fsAccess.mockRejectedValue(new Error("not found"));

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "nonexistent.txt",
      to: "new.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
  });

  it("rejects when destination exists and overwrite is false", async () => {
    mocks.fsAccess.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "source.txt",
      to: "existing.txt",
      overwrite: false,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { message?: string })?.message).toContain("already exists");
  });

  it("allows overwriting when overwrite is true", async () => {
    mocks.fsAccess.mockResolvedValue(undefined);
    mocks.fsMkdir.mockResolvedValue(undefined);
    mocks.fsRename.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.move", {
      agentId: "main",
      from: "source.txt",
      to: "existing.txt",
      overwrite: true,
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect(mocks.fsRename).toHaveBeenCalled();
  });
});

describe("agents.workspace.stat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns file metadata", async () => {
    mocks.fsStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 1024,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => false,
      isFile: () => true,
    } as unknown as Stats);

    mocks.fsAccess.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.stat", {
      agentId: "main",
      path: "file.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { type?: string })?.type).toBe("file");
    expect((lastCall?.result as { size?: number })?.size).toBe(1024);
    expect((lastCall?.result as { updatedAtMs?: number })?.updatedAtMs).toBe(1234567890);
    expect((lastCall?.result as { createdAtMs?: number })?.createdAtMs).toBe(1234567800);
    expect((lastCall?.result as { isWritable?: boolean })?.isWritable).toBe(true);
  });

  it("returns directory metadata", async () => {
    mocks.fsStat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    } as unknown as Stats);

    mocks.fsAccess.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.stat", {
      agentId: "main",
      path: "directory",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { type?: string })?.type).toBe("directory");
    expect((lastCall?.result as { size?: number })?.size).toBeUndefined();
  });

  it("returns symlink metadata", async () => {
    mocks.fsStat.mockResolvedValue({
      isFile: () => true,
      isDirectory: () => false,
      size: 100,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => true,
    } as unknown as Stats);

    mocks.fsAccess.mockResolvedValue(undefined);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.stat", {
      agentId: "main",
      path: "link",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { type?: string })?.type).toBe("symlink");
  });

  it("handles unreadable files (not writable)", async () => {
    mocks.fsStat.mockResolvedValue({
      isFile: () => true,
      size: 100,
      mtimeMs: 1234567890,
      ctimeMs: 1234567800,
    } as unknown as Stats);

    mocks.fsLstat.mockResolvedValue({
      isSymbolicLink: () => false,
    } as unknown as Stats);

    const error = new Error("Permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    mocks.fsAccess.mockRejectedValue(error);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.stat", {
      agentId: "main",
      path: "readonly.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
    expect((lastCall?.result as { isWritable?: boolean })?.isWritable).toBe(false);
  });

  it("returns error for non-existent files", async () => {
    mocks.fsStat.mockRejectedValue(new Error("not found"));
    mocks.fsLstat.mockRejectedValue(new Error("not found"));

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.stat", {
      agentId: "main",
      path: "nonexistent.txt",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect((lastCall?.error as { message?: string })?.message).toContain("not found");
  });
});

describe("agents.workspace error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles invalid agent ID", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValue(null as unknown as string);

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      agentId: "invalid-agent",
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("handles invalid parameters validation", async () => {
    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.list", {
      // Missing required agentId
    });

    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(false);
    expect((lastCall?.error as { code?: string })?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});

describe("agents.workspace parameter validation edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/test-workspace/main");
  });

  it("handles path with only dots", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "...",
    });

    // "..." is valid (not "..")
    const lastCall = getLastCall();
    expect(lastCall?.ok).toBe(true);
  });

  it("handles deeply nested valid paths", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/a/b/c/d/e/f/g/h/i/j/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "a/b/c/d/e/f/g/h/i/j/file.txt",
    });

    expect(getLastCall()?.ok).toBe(true);
  });

  it("handles path with backslashes (treated as path separators)", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main/file.txt",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "dir\\file.txt",
    });

    // Backslashes are treated as path separators by path.join
    expect(getLastCall()?.ok).toBe(true);
  });

  it("handles empty path", async () => {
    mocks.readFileWithinRoot.mockResolvedValue({
      buffer: Buffer.from("content"),
      stat: { size: 7, mtimeMs: Date.now() } as unknown as Stats,
      realPath: "/tmp/test-workspace/main",
    });

    const { getLastCall } = await invokeWorkspaceHandler("agents.workspace.get", {
      agentId: "main",
      path: "",
    });

    expect(getLastCall()?.ok).toBe(true);
  });
});
