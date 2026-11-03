import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers/bootstrap.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { registerAgentWorkspaceAccess, type AgentWorkspaceAccess } from "./workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession as filterForSession,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
  loadExtraBootstrapFilesWithDiagnostics as loadExtra,
  loadWorkspaceBootstrapFiles as loadBootstrap,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Bridge = AgentWorkspaceAccess["bridge"];

async function workspace(files: Record<string, string | Buffer> = {}) {
  const dir = tempDirs.make("bootstrap-");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

function mockBridge(overrides: Partial<Bridge> = {}): Bridge {
  return { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), ...overrides };
}

async function withAccess(
  dir: string,
  bridge: Bridge,
  run: (release: () => void) => Promise<unknown>,
) {
  const release = registerAgentWorkspaceAccess(dir, { bridge });
  try {
    await run(release);
  } finally {
    release();
  }
}

function bootstrapFile(
  name: WorkspaceBootstrapFile["name"],
  filePath = `/w/${name}`,
  content = "",
) {
  return { name, path: filePath, content, missing: false };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

it.runIf(process.platform !== "win32").each(["oversized", "invalid-utf8"] as const)(
  "preserves native bootstrap handling for %s remote files",
  async (kind) => {
    const bytes =
      kind === "oversized"
        ? Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1, "x")
        : Buffer.from([0x61, 0xff, 0x62]);
    const local = await workspace({ "AGENTS.md": "stale local document" });
    const remote = await workspace({ "AGENTS.md": bytes });
    const bridge = createRemoteShellSandboxFsBridge({
      sandbox: createSandboxTestContext({
        overrides: { workspaceDir: local, agentWorkspaceDir: local },
      }),
      runtime: {
        remoteWorkspaceDir: remote,
        remoteAgentWorkspaceDir: remote,
        runRemoteShellScript: createLocalRemoteShellScriptRunner(),
      },
    });
    await withAccess(local, bridge, async () => {
      const [file] = await loadBootstrap(local, [DEFAULT_AGENTS_FILENAME]);
      expect(file?.missing).toBe(false);
      if (kind === "oversized") {
        expect(file?.content).toContain("[UNREADABLE:");
        expect(await loadExtra(local, ["AGENTS.md"])).toMatchObject({
          files: [],
          diagnostics: [expect.anything()],
        });
      } else {
        expect(file?.content).toBe(bytes.toString("utf8"));
      }
      expect(file?.content).not.toContain("stale local document");
    });
  },
);

it("discovers remote extra documents without Gateway fallback", async () => {
  const local = await workspace({
    "AGENTS.md": "Gateway decoy",
    "packages/app/AGENTS.md": "Gateway decoy",
  });
  const remote = await workspace({
    "AGENTS.md": "remote root",
    "packages/app/AGENTS.md": "remote project",
  });
  const bridge: Bridge = {
    writeFile: vi.fn(),
    stat: async ({ filePath }) => {
      const stat = await fs.stat(path.join(remote, filePath));
      return {
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
    readFile: async ({ filePath }) => fs.readFile(path.join(remote, filePath)),
    readFileWithSource: async ({ filePath }) => ({
      data: await fs.readFile(path.join(remote, filePath)),
      canonicalPath: path.join(remote, filePath),
    }),
    readDirectory: async ({ filePath }) =>
      (await fs.readdir(path.join(remote, filePath), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
  };
  await withAccess(local, bridge, async () => {
    const { files, diagnostics } = await loadExtra(local, ["AGENTS.md", "packages/*/AGENTS.md"]);
    expect(diagnostics).toEqual([]);
    expect(files.map((file) => file.content)).toEqual(["remote root", "remote project"]);
  });
  await withAccess(local, { ...bridge, readDirectory: undefined }, async () => {
    const unavailable = await loadExtra(local, ["packages/*/AGENTS.md"]);
    expect(unavailable).toMatchObject({
      files: [],
      diagnostics: [
        {
          reason: "io",
          detail: expect.stringContaining("listing is unavailable"),
        },
      ],
    });
  });
});

it("omits missing remote files despite Gateway copies", async () => {
  const names = [DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME] as const;
  const local = await workspace(Object.fromEntries(names.map((name) => [name, "Gateway decoy"])));
  await withAccess(
    local,
    mockBridge({
      readFileWithSource: async () => {
        throw Object.assign(new Error("Remote file does not exist"), { code: "ENOENT" });
      },
    }),
    () => expect(loadBootstrap(local, names)).resolves.toEqual([]),
  );
});

it("does not split surrogate pairs when bounding unreadable reasons", async () => {
  const tempDir = await workspace({ "AGENTS.md": "# AGENTS.md\n" });
  const reason = `${"x".repeat(299)}😀tail`;
  vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    callback(new Error(reason));
  }) as typeof syncFs.read);
  const files = await loadBootstrap(tempDir);
  expect(files.find((file) => file.name === DEFAULT_AGENTS_FILENAME)?.content).toBe(
    `[UNREADABLE: ${"x".repeat(299)}]`,
  );
});

it.each(["revoked access", "missing provenance"] as const)(
  "rejects remote bootstrap content with %s without local fallback",
  async (failure) => {
    const tempDir = await workspace({ "AGENTS.md": "stale local document" });
    const missingProvenance = failure === "missing provenance";
    const readFile = missingProvenance
      ? vi.fn(async () => Buffer.from("unattributed remote document"))
      : vi.fn();
    const bridge = mockBridge({ readFile });
    let revoke = () => {};
    if (!missingProvenance) {
      bridge.readFileWithSource = vi.fn(async () => {
        revoke();
        return { data: Buffer.from("remote document"), canonicalPath: "/remote/AGENTS.md" };
      });
    }
    await withAccess(tempDir, bridge, async (release) => {
      revoke = release;
      await expect(loadBootstrap(tempDir)).rejects.toThrow(
        missingProvenance
          ? "Workspace bootstrap source identity is unavailable"
          : /Workspace access/,
      );
      if (missingProvenance) {
        expect(readFile).not.toHaveBeenCalled();
        expect(bridge.stat).not.toHaveBeenCalled();
      }
    });
  },
);

it("marks oversized files unreadable and logs the bounded-read reason", async () => {
  const tempDir = await workspace({
    "AGENTS.md": "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1),
  });
  const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const files = await loadBootstrap(tempDir);
  const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
  expect(agents).toMatchObject({
    missing: false,
    content: `[UNREADABLE: File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes]`,
  });
  expect(buildBootstrapContextFiles([agents!])).toEqual([
    { path: agentsPath, content: agents!.content },
  ]);
  const warningText = warn.mock.calls.flat().map(String).join("\n");
  expect(warningText).toContain(agentsPath);
  expect(warningText).toContain(`File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes`);
});

const mockFiles = (
  ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"] as const
).map((name) => bootstrapFile(name));

it("carries canonical source identity through extra-file conversion", async () => {
  const tempDir = await workspace({
    "MEMORY.md": "root memory",
    "packages/core/MEMORY.md": "nested memory",
  });
  const rootAliasDir = path.join(tempDir, "root-memory-alias[1]");
  const nestedAliasDir = path.join(tempDir, "nested-memory-alias");
  const aliasType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(tempDir, rootAliasDir, aliasType);
  await fs.symlink(path.join(tempDir, "packages/core"), nestedAliasDir, aliasType);
  const [rootMemory] = await loadBootstrap(tempDir, [DEFAULT_MEMORY_FILENAME]);
  const { files: aliases } = await loadExtra(tempDir, [
    "root-memory-alias[1]/MEMORY.md",
    "nested-memory-alias/MEMORY.md",
  ]);
  const rootAlias = aliases.find((file) => file.path.startsWith(rootAliasDir));
  const nestedAlias = aliases.find((file) => file.path.startsWith(nestedAliasDir));

  expect([rootMemory, rootAlias, nestedAlias]).not.toContain(undefined);
  expect(workspaceFilesShareSourceIdentity(rootMemory!, rootAlias!)).toBe(true);
  expect(workspaceFilesShareSourceIdentity(rootMemory!, nestedAlias!)).toBe(false);
});

it.each([
  ["group", "agent:default:opaque:binding"],
  ["direct", "agent:default:discord:channel:c1"],
] as const)(
  "prefers authoritative %s chat type over session-key fallback",
  (chatType, sessionKey) => {
    expect(filterForSession(mockFiles, { chatType, sessionKey })).toStrictEqual(
      chatType === "direct" ? mockFiles : mockFiles.filter((file) => file.name !== "MEMORY.md"),
    );
  },
);

it("shared sessions exclude root memory aliases but keep nested memory", () => {
  const rootMemoryAlias = bootstrapFile("SOUL.md", "/w/private/../MEMORY.md");
  const nestedMemory = bootstrapFile("MEMORY.md", "/w/packages/core/MEMORY.md");
  const result = filterForSession([rootMemoryAlias, nestedMemory], {
    sessionKey: "agent:default:opaque:binding",
    chatType: "channel",
    workspaceDir: "/w",
  });
  expect(result).toStrictEqual([nestedMemory]);
});

it.each([
  ["agent:default:subagent:task-1", "AGENTS.md"],
  ["agent:default:cron:daily-check", "SOUL.md"],
] as const)("filters root memory before the %s allowlist", (sessionKey, name) => {
  const allowedFile = mockFiles.find((file) => file.name === name)!;
  expect(
    filterForSession([allowedFile, bootstrapFile(name, "/w/MEMORY.md")], {
      sessionKey,
      workspaceDir: "/w",
    }),
  ).toStrictEqual([allowedFile]);
});

it("loads recognized bootstrap files from glob patterns", async () => {
  const workspaceDir = await workspace({
    "packages/core/SOUL.md": "soul",
    "packages/core/README.md": "not bootstrap",
  });
  const packageDir = path.join(workspaceDir, "packages", "core");
  const { files } = await loadExtra(workspaceDir, ["./packages/*/*"]);
  expect(files).toStrictEqual([bootstrapFile("SOUL.md", path.join(packageDir, "SOUL.md"), "soul")]);
});

it("keeps path-traversal attempts outside workspace excluded", async () => {
  const rootDir = await workspace({ "outside/AGENTS.md": "outside" });
  const workspaceDir = path.join(rootDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const { files } = await loadExtra(workspaceDir, ["../outside/AGENTS.md"]);
  expect(files).toHaveLength(0);
});

it.runIf(process.platform !== "win32")(
  "glob fallback avoids unrelated unreadable branches",
  async () => {
    const workspaceDir = await workspace({
      "packages/blocked/node_modules/private/AGENTS.md": "irrelevant",
      "packages/readable/AGENTS.md": "readable",
    });
    const privateDir = path.join(workspaceDir, "packages", "blocked", "node_modules", "private");
    const readableDir = path.join(workspaceDir, "packages", "readable");
    await fs.chmod(privateDir, 0o000);
    vi.spyOn(fs, "glob").mockImplementation(() => {
      throw new Error("native glob failed");
    });
    const readDirectory = vi.spyOn(fs, "readdir");
    try {
      const result = await loadExtra(workspaceDir, ["packages/*/AGENTS.md"]);
      expect(result).toMatchObject({
        diagnostics: [],
        files: [{ path: path.join(readableDir, "AGENTS.md") }],
      });
      expect(readDirectory).not.toHaveBeenCalledWith(privateDir, expect.anything());
    } finally {
      await fs.chmod(privateDir, 0o700);
    }
  },
);
