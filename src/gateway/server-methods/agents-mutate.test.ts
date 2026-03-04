import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  listAgentEntries: vi.fn(() => [] as Array<Record<string, unknown>>),
  findAgentEntryIndex: vi.fn(() => -1),
  applyAgentConfig: vi.fn((_cfg: unknown, _opts: unknown) => ({})),
  pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0, removedAllow: 0 })),
  writeConfigFile: vi.fn(async () => {}),
  ensureAgentWorkspace: vi.fn(async () => {}),
  resolveAgentDir: vi.fn(() => "/agents/test-agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/workspace/test-agent"),
  resolveAgentConfig: vi.fn((..._args: unknown[]) => undefined as unknown),
  resolveSessionTranscriptsDirForAgent: vi.fn(() => "/transcripts/test-agent"),
  resolveStorePath: vi.fn(
    (_store?: string, opts?: { agentId?: string }) => `/sessions/${opts?.agentId ?? "main"}.json`,
  ),
  loadSessionStore: vi.fn(
    (_storePath: string) =>
      ({
        "agent:main:main": {
          sessionId: "session-main",
          updatedAt: 10,
          sessionFile: "/transcripts/main/session-main.jsonl",
          systemPromptReport: {
            source: "run",
            generatedAt: 10,
            sessionId: "session-main",
            sessionKey: "agent:main:main",
            provider: "test",
            model: "test-model",
            workspaceDir: "/workspace/main",
            bootstrapMaxChars: 0,
            bootstrapTotalMaxChars: 0,
            systemPrompt: {
              chars: 0,
              projectContextChars: 0,
              nonProjectContextChars: 0,
            },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
        },
      }) as Record<string, unknown>,
  ),
  saveSessionStore: vi.fn(async (_storePath: string, _store: Record<string, unknown>) => {}),
  listAgentsForGateway: vi.fn(() => ({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "global",
    agents: [],
  })),
  movePathToTrash: vi.fn(async () => "/trashed"),
  fsAccess: vi.fn(async () => {}),
  fsMkdir: vi.fn(async () => undefined),
  fsCp: vi.fn(async () => undefined),
  fsCopyFile: vi.fn(async () => undefined),
  fsAppendFile: vi.fn(async () => {}),
  fsReadFile: vi.fn(async () => ""),
  fsStat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsLstat: vi.fn(async (..._args: unknown[]) => null as import("node:fs").Stats | null),
  fsRealpath: vi.fn(async (p: string) => p),
  fsOpen: vi.fn(async () => ({}) as unknown),
  cronList: vi.fn(async () => [] as Array<Record<string, unknown>>),
  cronRemove: vi.fn(async () => ({ ok: true, removed: false })),
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
  resolveAgentConfig: mocks.resolveAgentConfig,
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
  resolveStorePath: mocks.resolveStorePath,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  saveSessionStore: mocks.saveSessionStore,
}));

vi.mock("../../browser/trash.js", () => ({
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: (p: string) => `/resolved${p.startsWith("/") ? "" : "/"}${p}`,
  };
});

vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: mocks.listAgentsForGateway,
}));

// Mock node:fs/promises – agents.ts uses `import fs from "node:fs/promises"`
// which resolves to the module namespace default, so we spread actual and
// override the methods we need, plus set `default` explicitly.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const patched = {
    ...actual,
    access: mocks.fsAccess,
    mkdir: mocks.fsMkdir,
    cp: mocks.fsCp,
    copyFile: mocks.fsCopyFile,
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

function makeCall(
  method: keyof typeof agentsHandlers,
  params: Record<string, unknown>,
  opts?: { context?: unknown },
) {
  const respond = vi.fn();
  const handler = agentsHandlers[method];
  const promise = handler({
    params,
    respond,
    context: (opts?.context ?? {
      cron: {
        list: mocks.cronList,
        remove: mocks.cronRemove,
      },
    }) as never,
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

function expectNotFoundResponseAndNoWrite(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("not found") }),
  );
  expect(mocks.writeConfigFile).not.toHaveBeenCalled();
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
  mocks.resolveAgentWorkspaceDir.mockImplementation(() => "/workspace/test-agent");
  mocks.resolveAgentDir.mockImplementation(() => "/agents/test-agent");
  mocks.resolveSessionTranscriptsDirForAgent.mockImplementation(() => "/transcripts/test-agent");
  mocks.resolveStorePath.mockImplementation(
    (_store?: string, opts?: { agentId?: string }) => `/sessions/${opts?.agentId ?? "main"}.json`,
  );
  mocks.resolveAgentConfig.mockImplementation(() => undefined);
  mocks.fsAccess.mockImplementation(async () => undefined);
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
  mocks.fsCp.mockImplementation(async () => undefined);
  mocks.fsCopyFile.mockImplementation(async () => undefined);
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

describe("agents.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(-1);
    mocks.applyAgentConfig.mockImplementation((_cfg, _opts) => ({}));
  });

  it("creates a new agent successfully", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "Test Agent",
      workspace: "/home/user/agents/test",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "test-agent",
        name: "Test Agent",
      }),
      undefined,
    );
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("ensures workspace is set up before writing config", async () => {
    const callOrder: string[] = [];
    mocks.ensureAgentWorkspace.mockImplementation(async () => {
      callOrder.push("ensureAgentWorkspace");
    });
    mocks.writeConfigFile.mockImplementation(async () => {
      callOrder.push("writeConfigFile");
    });

    const { promise } = makeCall("agents.create", {
      name: "Order Test",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(callOrder.indexOf("ensureAgentWorkspace")).toBeLessThan(
      callOrder.indexOf("writeConfigFile"),
    );
  });

  it("rejects creating an agent with reserved 'main' id", async () => {
    const { respond, promise } = makeCall("agents.create", {
      name: "main",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("reserved") }),
    );
  });

  it("rejects creating a duplicate agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(0);

    const { respond, promise } = makeCall("agents.create", {
      name: "Existing",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("already exists") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects invalid params (missing name)", async () => {
    const { respond, promise } = makeCall("agents.create", {
      workspace: "/tmp/ws",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });

  it("always writes Name to IDENTITY.md even without emoji/avatar", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Plain Agent",
      workspace: "/tmp/ws",
    });
    await promise;

    expect(mocks.fsAppendFile).toHaveBeenCalledWith(
      expect.stringContaining("IDENTITY.md"),
      expect.stringContaining("- Name: Plain Agent"),
      "utf-8",
    );
  });

  it("writes emoji and avatar to IDENTITY.md when provided", async () => {
    const { promise } = makeCall("agents.create", {
      name: "Fancy Agent",
      workspace: "/tmp/ws",
      emoji: "🤖",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(mocks.fsAppendFile).toHaveBeenCalledWith(
      expect.stringContaining("IDENTITY.md"),
      expect.stringMatching(/- Name: Fancy Agent[\s\S]*- Emoji: 🤖[\s\S]*- Avatar:/),
      "utf-8",
    );
  });
});

describe("agents.clone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {
      session: { store: "/sessions/{agentId}.json" },
      bindings: [{ agentId: "main", match: { channel: "telegram" } }],
      tools: { agentToAgent: { allow: ["main"] } },
    };
    mocks.listAgentEntries.mockReturnValue([
      {
        id: "main",
        name: "Main Agent",
        workspace: "/workspace/main",
        agentDir: "/agents/main",
        memorySearch: {
          enabled: true,
          provider: "auto",
          model: "text-embedding-3-small",
          store: { driver: "sqlite", path: "/memory/{agentId}.sqlite", vector: { enabled: false } },
        },
      },
    ]);
    mocks.resolveAgentConfig.mockImplementation((...args: unknown[]) => {
      const candidate = args[1];
      const agentId = typeof candidate === "string" ? candidate : "";
      if (!agentId) {
        return undefined;
      }
      return {
        memorySearch: {
          enabled: true,
          provider: "auto",
          model: "text-embedding-3-small",
          store: { driver: "sqlite", path: "/memory/{agentId}.sqlite", vector: { enabled: false } },
        },
      };
    });
    mocks.resolveAgentWorkspaceDir.mockImplementation((...args: unknown[]) =>
      path.join("/workspace", typeof args[1] === "string" ? args[1] : "main"),
    );
    mocks.resolveAgentDir.mockImplementation((...args: unknown[]) =>
      path.join("/agents", typeof args[1] === "string" ? args[1] : "main"),
    );
    mocks.resolveSessionTranscriptsDirForAgent.mockImplementation((...args: unknown[]) =>
      path.join("/transcripts", typeof args[0] === "string" ? args[0] : "main"),
    );

    const existing = new Set([
      "/workspace/main",
      "/agents/main",
      "/sessions/main.json",
      "/transcripts/main",
      "/memory/main.sqlite",
    ]);
    mocks.fsAccess.mockImplementation(async (...args: unknown[]) => {
      const filePath = args[0];
      if (existing.has(String(filePath))) {
        return;
      }
      throw createEnoentError();
    });
  });

  it("clones workspace, sessions, memory, bindings, and cron jobs", async () => {
    const cronList = vi.fn(async () => [
      {
        id: "job-1",
        agentId: "main",
        sessionKey: "agent:main:main",
        name: "Morning check",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "status" },
        state: {},
      },
    ]);
    const cronAdd = vi.fn(async () => ({ id: "job-2" }));

    const { respond, promise } = makeCall(
      "agents.clone",
      { sourceAgentId: "main" },
      {
        context: {
          cron: {
            list: cronList,
            add: cronAdd,
          },
        },
      },
    );
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        sourceAgentId: "main",
        copied: expect.objectContaining({
          workspace: true,
          agentDir: true,
          sessionsStore: true,
          sessionsTranscripts: true,
          memoryStore: expect.any(Boolean),
          cronJobs: 1,
          bindings: 1,
        }),
      }),
      undefined,
    );

    const payload = respond.mock.calls[0]?.[1] as {
      agentId: string;
      copied: { cronJobs: number };
    };
    expect(payload.agentId).not.toBe("main");
    expect(payload.copied.cronJobs).toBe(1);
    expect(mocks.fsCp).toHaveBeenCalledTimes(3);
    expect(mocks.fsCopyFile).toHaveBeenCalled();
    expect(mocks.saveSessionStore).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(cronAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: payload.agentId,
        sessionKey: `agent:${payload.agentId}:main`,
      }),
    );

    const saveCall = mocks.saveSessionStore.mock.calls.at(0);
    expect(saveCall).toBeDefined();
    if (!saveCall) {
      throw new Error("expected saveSessionStore call");
    }
    const savedStorePath = String(saveCall[0]);
    const savedStore = saveCall[1] as Record<
      string,
      { sessionFile?: string; systemPromptReport?: { sessionKey?: string; workspaceDir?: string } }
    >;
    expect(savedStorePath).toBe(`/sessions/${payload.agentId}.json`);
    expect(Object.keys(savedStore)).toContain(`agent:${payload.agentId}:main`);
    expect(savedStore[`agent:${payload.agentId}:main`]?.sessionFile).toBe(
      `/transcripts/${payload.agentId}/session-main.jsonl`,
    );
    expect(savedStore[`agent:${payload.agentId}:main`]?.systemPromptReport?.sessionKey).toBe(
      `agent:${payload.agentId}:main`,
    );
    expect(savedStore[`agent:${payload.agentId}:main`]?.systemPromptReport?.workspaceDir).toBe(
      `/workspace/${payload.agentId}`,
    );
  });

  it("rejects cloning from unknown source agent", async () => {
    const { respond, promise } = makeCall("agents.clone", { sourceAgentId: "ghost" }, {});
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("not found") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("skips transcript directory copy when target transcripts already exist", async () => {
    const existing = new Set([
      "/workspace/main",
      "/agents/main",
      "/sessions/main.json",
      "/transcripts/main",
      "/transcripts/coordi",
      "/memory/main.sqlite",
    ]);
    mocks.fsAccess.mockImplementation(async (...args: unknown[]) => {
      const filePath = args[0];
      if (existing.has(String(filePath))) {
        return;
      }
      throw createEnoentError();
    });

    const { respond, promise } = makeCall("agents.clone", {
      sourceAgentId: "main",
      name: "coordi",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "coordi",
        copied: expect.objectContaining({ sessionsTranscripts: true }),
        warnings: expect.arrayContaining([
          "session transcript directory already present; skipped directory copy",
        ]),
      }),
      undefined,
    );
    expect(mocks.fsCp).not.toHaveBeenCalledWith(
      "/transcripts/main",
      "/transcripts/coordi",
      expect.anything(),
    );
  });

  it("skips cloning duplicate cron jobs already present for target agent", async () => {
    const cronList = vi.fn(async () => [
      {
        id: "job-source",
        agentId: "main",
        sessionKey: "agent:main:main",
        name: "Morning check",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "status" },
        state: {},
      },
      {
        id: "job-existing-target",
        agentId: "coordi",
        name: "Morning check",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "status" },
        state: {},
      },
    ]);
    const cronAdd = vi.fn(async () => ({ id: "job-new" }));

    const { respond, promise } = makeCall(
      "agents.clone",
      { sourceAgentId: "main", name: "coordi" },
      {
        context: {
          cron: {
            list: cronList,
            add: cronAdd,
          },
        },
      },
    );
    await promise;

    expect(cronAdd).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "coordi",
        copied: expect.objectContaining({ cronJobs: 0 }),
        warnings: expect.arrayContaining(['skipped 1 duplicate cron job for agent "coordi"']),
      }),
      undefined,
    );
  });
});

describe("agents.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.applyAgentConfig.mockImplementation((_cfg, _opts) => ({}));
  });

  it("updates an existing agent successfully", async () => {
    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Updated Name",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, { ok: true, agentId: "test-agent" }, undefined);
    expect(mocks.writeConfigFile).toHaveBeenCalled();
  });

  it("rejects updating a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.update", {
      agentId: "nonexistent",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("ensures workspace when workspace changes", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      workspace: "/new/workspace",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).toHaveBeenCalled();
  });

  it("does not ensure workspace when workspace is unchanged", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      name: "Just a rename",
    });
    await promise;

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });
});

describe("agents.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({ config: {}, removedBindings: 2, removedAllow: 1 });
    mocks.cronList.mockResolvedValue([]);
    mocks.cronRemove.mockResolvedValue({ ok: true, removed: false });
  });

  it("deletes an existing agent and trashes files by default", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        agentId: "test-agent",
        removedBindings: 2,
        removedAllow: 1,
        removedSessions: 0,
        removedCronJobs: 0,
      },
      undefined,
    );
    expect(mocks.writeConfigFile).toHaveBeenCalled();
    // moveToTrashBestEffort calls fs.access then movePathToTrash for each dir
    expect(mocks.movePathToTrash).toHaveBeenCalled();
    expect(mocks.movePathToTrash).toHaveBeenCalledWith(
      expect.stringContaining("/agents/test-agent"),
    );
  });

  it("removes agent sessions from store and cron jobs", async () => {
    const report = {
      source: "run",
      generatedAt: 10,
      sessionId: "session",
      sessionKey: "agent:test-agent:main",
      provider: "test",
      model: "test-model",
      workspaceDir: "/workspace/test-agent",
      bootstrapMaxChars: 0,
      bootstrapTotalMaxChars: 0,
      systemPrompt: {
        chars: 0,
        projectContextChars: 0,
        nonProjectContextChars: 0,
      },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };
    mocks.loadSessionStore.mockImplementationOnce(() => ({
      "agent:test-agent:main": {
        sessionId: "s-1",
        updatedAt: 10,
        sessionFile: "/transcripts/test-agent/s-1.jsonl",
        systemPromptReport: report,
      },
      "agent:test-agent:cron:job-1": {
        sessionId: "s-2",
        updatedAt: 20,
        sessionFile: "/transcripts/test-agent/s-2.jsonl",
        systemPromptReport: report,
      },
      "agent:main:main": {
        sessionId: "s-main",
        updatedAt: 30,
        sessionFile: "/transcripts/main/s-main.jsonl",
        systemPromptReport: report,
      },
    }));
    mocks.cronList.mockResolvedValue([
      { id: "job-a", agentId: "test-agent" },
      { id: "job-b", agentId: "main" },
    ] as never);
    mocks.cronRemove.mockResolvedValue({ ok: true, removed: true });

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expect(mocks.saveSessionStore).toHaveBeenCalledWith(
      "/sessions/test-agent.json",
      expect.not.objectContaining({
        "agent:test-agent:main": expect.anything(),
        "agent:test-agent:cron:job-1": expect.anything(),
      }),
    );
    expect(mocks.cronRemove).toHaveBeenCalledWith("job-a");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "test-agent",
        removedSessions: 2,
        removedCronJobs: 1,
      }),
      undefined,
    );
  });

  it("skips file deletion when deleteFiles is false", async () => {
    mocks.fsAccess.mockClear();

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, removedSessions: 0, removedCronJobs: 0 }),
      undefined,
    );
    // moveToTrashBestEffort should not be called at all
    expect(mocks.fsAccess).not.toHaveBeenCalled();
  });

  it("rejects deleting the main agent", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "main",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("cannot be deleted") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects deleting a nonexistent agent", async () => {
    mocks.findAgentEntryIndex.mockReturnValue(-1);

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "ghost",
    });
    await promise;

    expectNotFoundResponseAndNoWrite(respond);
  });

  it("rejects invalid params (missing agentId)", async () => {
    const { respond, promise } = makeCall("agents.delete", {});
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("invalid") }),
    );
  });
});

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
