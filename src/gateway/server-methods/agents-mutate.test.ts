import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SafeOpenError } from "../../infra/fs-safe.js";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => {
  const state = {
    writtenConfig: null as Record<string, unknown> | null,
    runtimeSnapshotActive: true,
    runtimeConfig: null as Record<string, unknown> | null,
  };
  return {
    state,
    loadConfigReturn: {} as Record<string, unknown>,
    clearConfigCache: vi.fn(),
    listAgentEntries: vi.fn((cfg?: Record<string, unknown>) => {
      const raw = (cfg as { __agentIds?: unknown } | undefined)?.__agentIds;
      const ids =
        Array.isArray(raw) && raw.length > 0
          ? raw.filter((value): value is string => typeof value === "string")
          : [];
      return ids.map((agentId) => ({ agentId }));
    }),
    findAgentEntryIndex: vi.fn((entries: Array<{ agentId: string }>, agentId: string) =>
      entries.findIndex((entry) => entry.agentId === agentId),
    ),
    applyAgentConfig: vi.fn((cfg: unknown, opts: unknown) => {
      const next =
        cfg && typeof cfg === "object"
          ? ({ ...(cfg as Record<string, unknown>) } as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const existingRaw = next.__agentIds;
      const existing =
        Array.isArray(existingRaw) && existingRaw.length > 0
          ? existingRaw.filter((value): value is string => typeof value === "string")
          : [];
      const candidateAgentId =
        opts && typeof opts === "object" ? (opts as { agentId?: unknown }).agentId : undefined;
      if (typeof candidateAgentId === "string" && candidateAgentId.trim()) {
        const normalized = candidateAgentId.trim();
        next.__agentIds = existing.includes(normalized) ? existing : [...existing, normalized];
      } else {
        next.__agentIds = existing;
      }
      return next;
    }),
    pruneAgentConfig: vi.fn(() => ({ config: {}, removedBindings: 0 })),
    writeConfigFile: vi.fn(async (cfg: unknown) => {
      if (cfg && typeof cfg === "object") {
        state.writtenConfig = { ...(cfg as Record<string, unknown>) };
        return;
      }
      state.writtenConfig = {};
    }),
    ensureAgentWorkspace: vi.fn(async () => {}),
    isWorkspaceSetupCompleted: vi.fn(async () => false),
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
    fsReadlink: vi.fn(async () => ""),
    fsOpen: vi.fn(async () => ({}) as unknown),
    getActiveSecretsRuntimeSnapshot: vi.fn(() =>
      state.runtimeSnapshotActive
        ? {
            sourceConfig: {},
            config: {},
            authStores: [],
            warnings: [],
          }
        : null,
    ),
    prepareSecretsRuntimeSnapshot: vi.fn(
      async ({ config }: { config: Record<string, unknown> }) => ({
        sourceConfig: config,
        config,
        authStores: [],
        warnings: [],
      }),
    ),
    activateSecretsRuntimeSnapshot: vi.fn((snapshot: { config: Record<string, unknown> }) => {
      state.runtimeSnapshotActive = true;
      state.runtimeConfig = snapshot.config;
    }),
    writeFileWithinRoot: vi.fn(async () => {}),
    refreshRuntimeConfigFromDisk: vi.fn(async () => {
      if (!state.runtimeSnapshotActive) {
        return;
      }
      state.runtimeConfig = state.writtenConfig ? { ...state.writtenConfig } : state.runtimeConfig;
    }),
  };
});

vi.mock("../../config/config.js", () => ({
  clearConfigCache: mocks.clearConfigCache,
  loadConfig: () => mocks.state.runtimeConfig ?? mocks.loadConfigReturn,
  projectConfigOntoRuntimeSourceSnapshot: <T>(cfg: T) => cfg,
  readConfigFileSnapshot: async () => {
    const config = mocks.state.writtenConfig ?? mocks.loadConfigReturn;
    return {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: config,
      resolved: config,
      valid: true,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  },
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../../commands/agents.config.js", () => ({
  applyAgentConfig: mocks.applyAgentConfig,
  findAgentEntryIndex: mocks.findAgentEntryIndex,
  listAgentEntries: mocks.listAgentEntries,
  pruneAgentConfig: mocks.pruneAgentConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: (cfg?: Record<string, unknown>) => {
    const raw = (cfg as { __agentIds?: unknown } | undefined)?.__agentIds;
    const ids =
      Array.isArray(raw) && raw.length > 0
        ? raw.filter((value): value is string => typeof value === "string")
        : [];
    return ["main", ...ids.filter((agentId) => agentId !== "main")];
  },
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
    isWorkspaceSetupCompleted: mocks.isWorkspaceSetupCompleted,
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

vi.mock("../../secrets/runtime.js", () => ({
  getActiveSecretsRuntimeSnapshot: mocks.getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot: mocks.prepareSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshot: mocks.activateSecretsRuntimeSnapshot,
}));
vi.mock("../../infra/fs-safe.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../infra/fs-safe.js")>("../../infra/fs-safe.js");
  return {
    ...actual,
    appendFileWithinRoot: mocks.appendFileWithinRoot,
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
    readlink: mocks.fsReadlink,
    open: mocks.fsOpen,
  };
  return { ...patched, default: patched };
});

/* ------------------------------------------------------------------ */
/* Import after mocks are set up                                      */
/* ------------------------------------------------------------------ */

const { __testing: agentsTesting, agentsHandlers } = await import("./agents.js");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  agentsTesting.resetDepsForTests();
});

function makeCall(method: keyof typeof agentsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const handler = agentsHandlers[method];
  const promise = handler({
    params,
    respond,
    context: {
      refreshRuntimeConfigFromDisk: mocks.refreshRuntimeConfigFromDisk,
    } as never,
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

function mockWorkspaceStateRead(params: {
  setupCompletedAt?: string;
  errorCode?: string;
  rawContent?: string;
}) {
  agentsTesting.setDepsForTests({
    isWorkspaceSetupCompleted: async () => {
      if (params.errorCode) {
        throw createErrnoError(params.errorCode);
      }
      if (typeof params.rawContent === "string") {
        throw new SyntaxError("Expected property name or '}' in JSON");
      }
      return (
        typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0
      );
    },
  });
  mocks.isWorkspaceSetupCompleted.mockImplementation(async () => {
    if (params.errorCode) {
      throw createErrnoError(params.errorCode);
    }
    if (typeof params.rawContent === "string") {
      throw new SyntaxError("Expected property name or '}' in JSON");
    }
    return typeof params.setupCompletedAt === "string" && params.setupCompletedAt.trim().length > 0;
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
  mocks.state.writtenConfig = null;
  mocks.state.runtimeSnapshotActive = true;
  mocks.state.runtimeConfig = null;
  mocks.refreshRuntimeConfigFromDisk.mockImplementation(async () => {
    if (!mocks.state.runtimeSnapshotActive) {
      return;
    }
    mocks.state.runtimeConfig = mocks.state.writtenConfig ? { ...mocks.state.writtenConfig } : null;
  });
  mocks.writeConfigFile.mockImplementation(async (cfg: unknown) => {
    if (cfg && typeof cfg === "object") {
      mocks.state.writtenConfig = { ...(cfg as Record<string, unknown>) };
      return;
    }
    mocks.state.writtenConfig = {};
  });
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

describe("agents.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockImplementation(
      (entries: Array<{ agentId: string }>, agentId: string) =>
        entries.findIndex((entry) => entry.agentId === agentId),
    );
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

  it("refreshes runtime snapshot so follow-up RPCs can resolve the new agent", async () => {
    mocks.loadConfigReturn = { gateway: { reload: { mode: "off" } } };
    const { respond, promise } = makeCall("agents.create", {
      name: "Ready Agent",
      workspace: "/home/user/agents/ready",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "ready-agent",
      }),
      undefined,
    );
    expect(mocks.refreshRuntimeConfigFromDisk).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRuntimeConfigFromDisk).toHaveBeenCalledWith();

    const { respond: filesRespond, promise: filesPromise } = makeCall("agents.files.list", {
      agentId: "ready-agent",
    });
    await filesPromise;
    expect(filesRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ agentId: "ready-agent" }),
      undefined,
    );
  });

  it("skips an extra refresh when the written agent is already runtime-visible", async () => {
    mocks.loadConfigReturn = { gateway: { reload: { mode: "off" } } };
    mocks.writeConfigFile.mockImplementationOnce(async (cfg: unknown) => {
      if (cfg && typeof cfg === "object") {
        const nextConfig = { ...(cfg as Record<string, unknown>) };
        mocks.state.writtenConfig = nextConfig;
        mocks.state.runtimeConfig = nextConfig;
        return;
      }
      mocks.state.writtenConfig = {};
      mocks.state.runtimeConfig = {};
    });

    const { respond, promise } = makeCall("agents.create", {
      name: "Visible Agent",
      workspace: "/home/user/agents/visible",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "visible-agent",
      }),
      undefined,
    );
    expect(mocks.refreshRuntimeConfigFromDisk).not.toHaveBeenCalled();
  });

  it("retries runtime refresh during readiness polling after transient failures", async () => {
    const previousTimeout = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
    const previousPoll = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = "250";
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = "10";
    mocks.state.runtimeConfig = null;
    let refreshAttempts = 0;
    mocks.refreshRuntimeConfigFromDisk.mockImplementation(async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) {
        throw new Error("temporary refresh failure");
      }
      mocks.state.runtimeConfig = mocks.state.writtenConfig
        ? { ...mocks.state.writtenConfig }
        : null;
    });
    try {
      const { respond, promise } = makeCall("agents.create", {
        name: "Retry Agent",
        workspace: "/home/user/agents/retry",
      });
      await promise;

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          agentId: "retry-agent",
        }),
        undefined,
      );
      expect(refreshAttempts).toBeGreaterThan(1);
    } finally {
      mocks.refreshRuntimeConfigFromDisk.mockImplementation(async () => {
        if (!mocks.state.runtimeSnapshotActive) {
          return;
        }
        mocks.state.runtimeConfig = mocks.state.writtenConfig
          ? { ...mocks.state.writtenConfig }
          : mocks.state.runtimeConfig;
      });
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = previousTimeout;
      }
      if (previousPoll === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = previousPoll;
      }
    }
  });

  it("uses the latest disk-visible config during readiness refresh", async () => {
    mocks.state.runtimeConfig = null;
    let refreshAttempts = 0;
    const refreshPayloads: Array<Record<string, unknown> | undefined> = [];
    mocks.refreshRuntimeConfigFromDisk.mockImplementation(async (cfg?: Record<string, unknown>) => {
      refreshAttempts += 1;
      refreshPayloads.push(cfg ? { ...cfg } : undefined);
      if (refreshAttempts === 1) {
        // Simulate a concurrent config write landing after agents.create wrote its initial config.
        mocks.state.writtenConfig = {
          ...mocks.state.writtenConfig,
          __agentIds: ["stale-safe-agent", "newer-agent"],
        };
        return;
      }
      mocks.state.runtimeConfig = mocks.state.writtenConfig
        ? { ...mocks.state.writtenConfig }
        : null;
    });

    const { respond, promise } = makeCall("agents.create", {
      name: "Stale Safe Agent",
      workspace: "/home/user/agents/stale-safe",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        agentId: "stale-safe-agent",
      }),
      undefined,
    );
    expect(refreshAttempts).toBeGreaterThan(1);
    const lastRefresh = refreshPayloads.at(-1);
    expect(lastRefresh).toBeUndefined();
    expect((mocks.state.runtimeConfig as { __agentIds?: string[] } | null)?.__agentIds).toEqual(
      expect.arrayContaining(["stale-safe-agent", "newer-agent"]),
    );
  });

  it("ensures workspace is set up before writing config", async () => {
    const callOrder: string[] = [];
    mocks.ensureAgentWorkspace.mockImplementation(async () => {
      callOrder.push("ensureAgentWorkspace");
    });
    mocks.writeConfigFile.mockImplementation(async (cfg: unknown) => {
      callOrder.push("writeConfigFile");
      if (cfg && typeof cfg === "object") {
        mocks.state.writtenConfig = { ...(cfg as Record<string, unknown>) };
      }
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

    expect(mocks.appendFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/tmp/ws",
        relativePath: "IDENTITY.md",
        data: expect.stringContaining("- Name: Plain Agent"),
        encoding: "utf8",
      }),
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

    expect(mocks.appendFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/resolved/tmp/ws",
        relativePath: "IDENTITY.md",
        data: expect.stringMatching(/- Name: Fancy Agent[\s\S]*- Emoji: 🤖[\s\S]*- Avatar:/),
        encoding: "utf8",
      }),
    );
  });

  it("fails readiness when runtime config never includes the newly written agent", async () => {
    const previousTimeout = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
    const previousPoll = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = "25";
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = "5";
    mocks.state.runtimeSnapshotActive = false;
    try {
      const { respond, promise } = makeCall("agents.create", {
        name: "Never Visible Agent",
        workspace: "/tmp/ws",
      });
      await promise;

      expect(mocks.refreshRuntimeConfigFromDisk).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("created but not yet resolvable"),
        }),
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = previousTimeout;
      }
      if (previousPoll === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = previousPoll;
      }
    }
  });

  it("waits for an in-flight readiness refresh to settle before timing out", async () => {
    const previousTimeout = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
    const previousPoll = process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = "20";
    process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = "5";
    mocks.state.runtimeConfig = null;
    const refreshControl: { release: (() => void) | null } = { release: null };
    mocks.refreshRuntimeConfigFromDisk.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          refreshControl.release = resolve;
        }),
    );
    try {
      const { respond, promise } = makeCall("agents.create", {
        name: "Slow Refresh Agent",
        workspace: "/tmp/ws",
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(respond).not.toHaveBeenCalled();

      const release = refreshControl.release;
      if (typeof release !== "function") {
        throw new Error("expected readiness refresh to start");
      }
      release();
      await promise;

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("created but not yet resolvable"),
        }),
      );
      expect(mocks.refreshRuntimeConfigFromDisk).toHaveBeenCalledTimes(1);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_TIMEOUT_MS = previousTimeout;
      }
      if (previousPoll === undefined) {
        delete process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS;
      } else {
        process.env.OPENCLAW_GATEWAY_AGENT_CREATE_READY_POLL_MS = previousPoll;
      }
    }
  });
});

describe("agents.update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
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

  it("appends avatar updates through appendFileWithinRoot", async () => {
    const { promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(mocks.appendFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
        data: "\n- Avatar: https://example.com/avatar.png\n",
        encoding: "utf8",
      }),
    );
  });

  it("rejects updating an agent when IDENTITY.md resolves outside the workspace", async () => {
    const workspace = "/workspace/test-agent";
    agentsTesting.setDepsForTests({
      resolveAgentWorkspaceFilePath: async ({ name }) => ({
        kind: "invalid",
        requestPath: path.join(workspace, name),
        reason: "path escapes workspace root",
      }),
    });

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "evil.png",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    expect(mocks.appendFileWithinRoot).not.toHaveBeenCalled();
  });

  it("does not persist config when avatar append is rejected after preflight", async () => {
    mocks.appendFileWithinRoot.mockRejectedValueOnce(
      new SafeOpenError("path-mismatch", "path escapes workspace root"),
    );

    const { respond, promise } = makeCall("agents.update", {
      agentId: "test-agent",
      avatar: "https://example.com/avatar.png",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("unsafe workspace file") }),
    );
    expect(mocks.appendFileWithinRoot).toHaveBeenCalledTimes(1);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
});

describe("agents.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfigReturn = {};
    mocks.findAgentEntryIndex.mockReturnValue(0);
    mocks.pruneAgentConfig.mockReturnValue({ config: {}, removedBindings: 2 });
  });

  it("deletes an existing agent and trashes files by default", async () => {
    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, agentId: "test-agent", removedBindings: 2 },
      undefined,
    );
    expect(mocks.writeConfigFile).toHaveBeenCalled();
    // moveToTrashBestEffort calls fs.access then movePathToTrash for each dir
    expect(mocks.movePathToTrash).toHaveBeenCalled();
  });

  it("skips file deletion when deleteFiles is false", async () => {
    mocks.fsAccess.mockClear();

    const { respond, promise } = makeCall("agents.delete", {
      agentId: "test-agent",
      deleteFiles: false,
    });
    await promise;

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
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
    mocks.isWorkspaceSetupCompleted.mockReset().mockResolvedValue(false);
    mocks.fsReadlink.mockReset().mockResolvedValue("");
  });

  it("includes BOOTSTRAP.md when setup has not completed", async () => {
    const names = await listAgentFileNames();
    expect(names).toContain("BOOTSTRAP.md");
  });

  it("hides BOOTSTRAP.md when workspace setup is complete", async () => {
    mockWorkspaceStateRead({ setupCompletedAt: "2026-02-15T14:00:00.000Z" });

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
    agentsTesting.setDepsForTests({
      resolveAgentWorkspaceFilePath: async ({ name }) => ({
        kind: "invalid",
        requestPath: path.join(workspace, name),
        reason: "path escapes workspace root",
      }),
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

  it("allows in-workspace symlink reads and writes through symlink aliases", async () => {
    const workspace = "/workspace/test-agent";
    const target = path.resolve(workspace, "policies", "AGENTS.md");
    const targetStat = makeFileStat({ size: 7, mtimeMs: 1700, dev: 9, ino: 42 });

    agentsTesting.setDepsForTests({
      readLocalFileSafely: async () => ({
        buffer: Buffer.from("inside\n"),
        realPath: target,
        stat: targetStat,
      }),
      resolveAgentWorkspaceFilePath: async ({ name }) => ({
        kind: "ready",
        requestPath: path.join(workspace, name),
        ioPath: target,
        workspaceReal: workspace,
      }),
    });
    mocks.fsLstat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (p === target) {
        return targetStat;
      }
      throw createEnoentError();
    });
    mocks.fsStat.mockImplementation(async (...args: unknown[]) => {
      const p = typeof args[0] === "string" ? args[0] : "";
      if (path.resolve(p) === target) {
        return targetStat;
      }
      throw createEnoentError();
    });

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
      true,
      expect.objectContaining({
        ok: true,
        file: expect.objectContaining({ missing: false, content: "updated\n" }),
      }),
      undefined,
    );
    expect(mocks.writeFileWithinRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        rootDir: workspace,
        relativePath: path.join("policies", "AGENTS.md"),
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
