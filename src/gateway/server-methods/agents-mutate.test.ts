import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentEntries: vi.fn(() => [] as Array<{ agentId: string }>),
  findAgentEntryIndex: vi.fn(() => -1),
  applyAgentConfig: vi.fn((_cfg: unknown, _opts: unknown) => ({})),
  pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0 })),
  writeConfigFile: vi.fn(async () => {}),
  ensureAgentWorkspace: vi.fn(async () => {}),
  resolveAgentDir: vi.fn(() => "/agents/test-agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace/test-agent"),
  resolveSessionTranscriptsDirForAgent: vi.fn(() => "/transcripts/test-agent"),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn(async () => "/trashed"),
  fsAccess: vi.fn(async () => {}),
  fsMkdir: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => ""),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsRealpath: vi.fn(async (p: string) => p),
  fsOpen: vi.fn(async () => ({}) as unknown),
  writeFileWithinRoot: vi.fn(async () => {}),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
  findAgentEntryIndex: mocks.findAgentEntryIndex,
  listAgentEntries: mocks.listAgentEntries,
  pruneAgentConfig: mocks.pruneAgentConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../agents/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/workspace.js")>(
    "../../agents/workspace.js",
  );
  return {
    ...actual,
    ensureAgentWorkspace: mocks.ensureAgentWorkspace,
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: mocks.resolveSessionTranscriptsDirForAgent,
}));

vi.mock("../../browser/trash.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../../utils.js", () => ({
  resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
}));

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    writeFileWithinRoot: mocks.writeFileWithinRoot,
  };
});

// Mock node:fs/promises – agents.ts uses `import fs from "node:fs/promises"`
// which resolves to the module namespace default, so we spread actual and
// override the methods we need, plus set `default` explicitly.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    access: mocks.fsAccess,
    mkdir: mocks.fsMkdir,
    appendFile: mocks.fsAppendFile,
    readFile: mocks.fsReadFile,
    stat: mocks.fsStat,
    lstat: mocks.fsLstat,
    realpath: mocks.fsRealpath,
    open: mocks.fsOpen,
  };
  return { ...patched, default: patched };
});

/* ------------------------------------------------------------------ */
/* Import after mocks are set up                                      */
/* ------------------------------------------------------------------ */

const { agentsHandlers } = await import("./agents.js");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = agentsHandlers[method];
  const promise = handler({
    params,
    respond,
    context: {} as never,
    req: { type: "req" as const, id: "1", method },
    client: null,
    isWebchatConnect: () => false,
  });
  return { respond, promise };
}

function createEnoentError() {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function createErrnoError(code: string) {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeFileStat(params?: {
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  nlink?: number;
}): import("node:fs").Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: params?.size ?? 10,
    mtimeMs: params?.mtimeMs ?? 1234,
    dev: params?.dev ?? 1,
    ino: params?.ino ?? 1,
    nlink: params?.nlink ?? 1,
  } as unknown as import("node:fs").Stats;
}

function makeSymlinkStat(params?: { dev?: number; ino?: number }): import("node:fs").Stats {
  return {
    isFile: () => false,
    isSymbolicLink: () => true,
    size: 0,
    mtimeMs: 0,
    dev: params?.dev ?? 1,
    ino: params?.ino ?? 2,
  } as unknown as import("node:fs").Stats;
}

function mockWorkspaceStateRead(params: {
  onboardingCompletedAt?: string;
  errorCode?: string;
  rawContent?: string;
}) {
  mocks.fsReadFile.mockImplementation(async (...args: unknown[]) => {
    const filePath = args[0];
    if (String(filePath).endsWith("workspace-state.json")) {
      if (params.errorCode) {
        throw createErrnoError(params.errorCode);
      }
      if (typeof params.rawContent === "string") {
        return params.rawContent;
      }
      return JSON.stringify({
        onboardingCompletedAt: params.onboardingCompletedAt ?? "2026-02-15T14:00:00.000Z",
      });
    }
    throw createEnoentError();
  });
}

async function listAgentFileNames(agentId = "main") {
  const { respond, promise } = makeCall("agents.files.list", { agentId });
  await promise;

  const [, result] = respond.mock.calls[0] ?? [];
  const files = (result as { files: Array<{ name: string }> }).files;
  return files.map((file) => file.name);
}

async function expectUnsafeWorkspaceFile(method: "agents.files.get" | "agents.files.set") {
  const params =
    method === "agents.files.set"
      ? { agentId: "main", name: "AGENTS.md", content: "x" }
      : { agentId: "main", name: "AGENTS.md" };
  const { respond, promise } = makeCall(method, params);
  await promise;
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
  );
}

beforeEach(() => {
  mocks.fsReadFile.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsStat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsLstat.mockImplementation(async () => {
    throw createEnoentError();
  });
  mocks.fsRealpath.mockImplementation(async (p: string) => p);
  mocks.fsOpen.mockImplementation(
    async () =>
      ({
        stat: async () => makeFileStat(),
        readFile: async () => Buffer.from(""),
        truncate: async () => {},
        writeFile: async () => {},
        close: async () => {},
      }) as unknown,
  );
});

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("agents.files.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
  });

  it("includes BOOTSTRAP.md when onboarding has not completed", async () => {
    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("hides BOOTSTRAP.md when workspace onboarding is complete", async () => {
    mockWorkspaceStateRead({ onboardingCompletedAt: "2026-02-15T14:00:00.000Z" });

    const names = await listAgentFileNames();
    expect(names).not.toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state cannot be read", async () => {
    mockWorkspaceStateRead({ errorCode: "EACCES" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("falls back to showing BOOTSTRAP.md when workspace state is malformed JSON", async () => {
    mockWorkspaceStateRead({ rawContent: "{" });

    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });
});

describe("agents.files.get/set symlink safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.fsMkdir.mockResolvedValue(undefined);
  });

  function mockWorkspaceEscapeSymlink() {
    const workspace = "/workspace/test-agent";
    const candidate = path.resolve(workspace, "AGENTS.md");
    mocks.fsRealpath.mockImplementation(async (p: string) => {
      if (p === workspace) {
        return workspace;
      }
      if (p === candidate) {
        return "/outside/secret.txt";
      }
      return p;
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === candidate) {
        return makeSymlinkStat();
      }
      throw createEnoentError();
    });
  }

  it.each([
    { method: "agents.files.get" as const, expectNoOpen: false },
    { method: "agents.files.set" as const, expectNoOpen: true },
  ])(
    "rejects $method when allowlisted file symlink escapes workspace",
    async ({ method, expectNoOpen }) => {
      mockWorkspaceEscapeSymlink();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );

  it("allows in-workspace symlink reads but rejects writes through symlink aliases", async () => {
    const workspace = "/workspace/test-agent";
    const candidate = path.resolve(workspace, "AGENTS.md");
    const target = path.resolve(workspace, "policies", "AGENTS.md");
    const targetStat = makeFileStat({ size: 7, mtimeMs: 1700, dev: 9, ino: 42 });

    mocks.fsRealpath.mockImplementation(async (p: string) => {
      if (p === workspace) {
        return workspace;
      }
      if (p === candidate) {
        return target;
      }
      return p;
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === candidate) {
        return makeSymlinkStat({ dev: 9, ino: 41 });
      }
      if (p === target) {
        return targetStat;
      }
      throw createEnoentError();
    });
    mocks.fsStat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === target) {
        return targetStat;
      }
      throw createEnoentError();
    });
    mocks.fsOpen.mockImplementation(
      async () =>
        ({
          stat: async () => targetStat,
          readFile: async () => Buffer.from("inside\n"),
          truncate: async () => {},
          writeFile: async () => {},
          close: async () => {},
        }) as unknown,
    );

    const getCall = makeCall("agents.files.get", { agentId: "main", name: "AGENTS.md" });
    await getCall.promise;
    expect(getCall.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        file: expect.objectContaining({ missing: false, content: "inside\n" }),
      }),
      undefined,
    );

    const setCall = makeCall("agents.files.set", {
      agentId: "main",
      name: "AGENTS.md",
      content: "updated\n",
    });
    await setCall.promise;
    expect(setCall.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining('unsafe workspace file "AGENTS.md"'),
      }),
    );
  });

  function mockHardlinkedWorkspaceAlias() {
    const workspace = "/workspace/test-agent";
    const candidate = path.resolve(workspace, "AGENTS.md");
    mocks.fsRealpath.mockImplementation(async (p: string) => {
      if (p === workspace) {
        return workspace;
      }
      return p;
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === candidate) {
        return makeFileStat({ nlink: 2 });
      }
      throw createEnoentError();
    });
  }

  it.each([
    { method: "agents.files.get" as const, expectNoOpen: false },
    { method: "agents.files.set" as const, expectNoOpen: true },
  ])(
    "rejects $method when allowlisted file is a hardlinked alias",
    async ({ method, expectNoOpen }) => {
      mockHardlinkedWorkspaceAlias();
      await expectUnsafeWorkspaceFile(method);
      if (expectNoOpen) {
        expect(mocks.fsOpen).not.toHaveBeenCalled();
      }
    },
  );
});
