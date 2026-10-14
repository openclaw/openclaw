import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
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
  filterBootstrapFilesForSession,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
  loadExtraBootstrapFilesWithDiagnostics,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

describe("workspace bootstrap read diagnostics", () => {
  it.runIf(process.platform !== "win32").each(["oversized", "invalid-utf8"] as const)(
    "preserves native bootstrap handling for %s remote files",
    async (kind) => {
      const workspace = tempDirs.make("bootstrap-parity-gateway-");
      const remote = tempDirs.make("bootstrap-parity-harness-");
      const bytes =
        kind === "oversized"
          ? Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1, "x")
          : Buffer.from([0x61, 0xff, 0x62]);
      await fs.writeFile(path.join(remote, DEFAULT_AGENTS_FILENAME), bytes);
      await fs.writeFile(path.join(workspace, DEFAULT_AGENTS_FILENAME), "stale local document");
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: { workspaceDir: workspace, agentWorkspaceDir: workspace },
        }),
        runtime: {
          remoteWorkspaceDir: remote,
          remoteAgentWorkspaceDir: remote,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      const release = registerAgentWorkspaceAccess(workspace, { bridge });
      try {
        const [file] = await loadWorkspaceBootstrapFiles(workspace, [DEFAULT_AGENTS_FILENAME]);
        expect(file?.missing).toBe(false);
        if (kind === "oversized") {
          expect(file?.content).toContain("[UNREADABLE:");
          const extra = await loadExtraBootstrapFilesWithDiagnostics(workspace, [
            DEFAULT_AGENTS_FILENAME,
          ]);
          expect(extra.files).toEqual([]);
          expect(extra.diagnostics).toHaveLength(1);
        } else {
          expect(file?.content).toBe(bytes.toString("utf8"));
        }
        expect(file?.content).not.toContain("stale local document");
      } finally {
        release();
      }
    },
  );

  it("loads configured extra documents from the remote workspace, including glob discovery", async () => {
    const workspace = tempDirs.make("bootstrap-gateway-");
    const remote = tempDirs.make("bootstrap-harness-");
    for (const root of [workspace, remote]) {
      await fs.mkdir(path.join(root, "packages/app"), { recursive: true });
      await fs.writeFile(
        path.join(root, "AGENTS.md"),
        root === remote ? "remote root" : "Gateway decoy",
      );
      await fs.writeFile(
        path.join(root, "packages/app/AGENTS.md"),
        root === remote ? "remote project" : "Gateway decoy",
      );
    }
    const bridge: AgentWorkspaceAccess["bridge"] = {
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
    const release = registerAgentWorkspaceAccess(workspace, { bridge });
    try {
      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspace, [
        "AGENTS.md",
        "packages/*/AGENTS.md",
      ]);
      expect(diagnostics).toEqual([]);
      expect(files.map((file) => file.content)).toEqual(["remote root", "remote project"]);
    } finally {
      release();
    }
    const releaseWithoutListing = registerAgentWorkspaceAccess(workspace, {
      bridge: { ...bridge, readDirectory: undefined },
    });
    try {
      const unavailable = await loadExtraBootstrapFilesWithDiagnostics(workspace, [
        "packages/*/AGENTS.md",
      ]);
      expect(unavailable.files).toEqual([]);
      expect(unavailable.diagnostics).toEqual([
        expect.objectContaining({
          reason: "io",
          detail: expect.stringContaining("listing is unavailable"),
        }),
      ]);
    } finally {
      releaseWithoutListing();
    }
  });

  it("omits missing remote MEMORY.md and USER.md even when Gateway copies exist", async () => {
    const workspace = tempDirs.make("bootstrap-missing-remote-");
    const names = [DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME] as const;
    for (const name of names) {
      await fs.writeFile(path.join(workspace, name), "Gateway decoy");
    }
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        stat: vi.fn(),
        readFileWithSource: async () => {
          throw Object.assign(new Error("Remote file does not exist"), { code: "ENOENT" });
        },
      },
    });
    try {
      await expect(loadWorkspaceBootstrapFiles(workspace, names)).resolves.toEqual([]);
    } finally {
      release();
    }
  });

  it("does not split surrogate pairs when bounding unreadable reasons", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-");
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "# AGENTS.md\n");
    const reason = `${"x".repeat(299)}😀tail`;
    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error(reason));
    }) as typeof syncFs.read);

    try {
      const files = await loadWorkspaceBootstrapFiles(tempDir);
      expect(files.find((file) => file.name === DEFAULT_AGENTS_FILENAME)?.content).toBe(
        `[UNREADABLE: ${"x".repeat(299)}]`,
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it.each(["revoked access", "missing provenance"] as const)(
    "rejects remote bootstrap content with %s without local fallback",
    async (failure) => {
      const tempDir = tempDirs.make("openclaw-remote-workspace-no-source-");
      await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "stale local document");
      const missingProvenance = failure === "missing provenance";
      let release = () => {};
      const readFile = missingProvenance
        ? vi.fn(async () => Buffer.from("unattributed remote document"))
        : vi.fn();
      const stat = vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>();
      const bridge: AgentWorkspaceAccess["bridge"] = {
        readFile,
        writeFile: vi.fn(),
        stat,
      };
      if (!missingProvenance) {
        bridge.readFileWithSource = vi.fn(async () => {
          release();
          return { data: Buffer.from("remote document"), canonicalPath: "/remote/AGENTS.md" };
        });
      }
      release = registerAgentWorkspaceAccess(tempDir, { bridge });
      try {
        await expect(loadWorkspaceBootstrapFiles(tempDir)).rejects.toThrow(
          missingProvenance
            ? "Workspace bootstrap source identity is unavailable"
            : /Workspace access/,
        );
        if (missingProvenance) {
          expect(readFile).not.toHaveBeenCalled();
          expect(stat).not.toHaveBeenCalled();
        }
      } finally {
        release();
      }
    },
  );

  it("marks oversized bootstrap files unreadable and warns with the bounded-read reason", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1));
    const warn = captureWarningLogger();

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(agents?.missing).toBe(false);
    expect(agents?.content).toBe(
      `[UNREADABLE: File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes]`,
    );
    if (!agents) {
      throw new Error("expected AGENTS.md bootstrap record");
    }
    expect(buildBootstrapContextFiles([agents])).toEqual([
      { path: agentsPath, content: agents.content },
    ]);
    expect(warningText).toContain(agentsPath);
    expect(warningText).toContain(`File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes`);
  });
});

const mockFiles: WorkspaceBootstrapFile[] = [
  { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
  { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
  { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
  { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
  { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
  { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
];

describe("workspace bootstrap source identity", () => {
  it("carries canonical source identity through extra-file conversion", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-source-identity-");
    const nestedDir = path.join(tempDir, "packages", "core");
    const rootAliasDir = path.join(tempDir, "root-memory-alias");
    const nestedAliasDir = path.join(tempDir, "nested-memory-alias");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_MEMORY_FILENAME), "root memory", "utf8");
    await fs.writeFile(path.join(nestedDir, DEFAULT_MEMORY_FILENAME), "nested memory", "utf8");
    await fs.symlink(tempDir, rootAliasDir, process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(nestedDir, nestedAliasDir, process.platform === "win32" ? "junction" : "dir");

    const rootMemory = (await loadWorkspaceBootstrapFiles(tempDir)).find(
      (file) => file.name === DEFAULT_MEMORY_FILENAME,
    );
    const { files: aliases } = await loadExtraBootstrapFilesWithDiagnostics(tempDir, [
      path.relative(tempDir, path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME)),
      path.relative(tempDir, path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME)),
    ]);
    const rootAlias = aliases.find((file) => file.path.startsWith(rootAliasDir));
    const nestedAlias = aliases.find((file) => file.path.startsWith(nestedAliasDir));

    expect(rootMemory).toBeDefined();
    expect(rootAlias).toBeDefined();
    expect(nestedAlias).toBeDefined();
    expect(workspaceFilesShareSourceIdentity(rootMemory!, rootAlias!)).toBe(true);
    expect(workspaceFilesShareSourceIdentity(rootMemory!, nestedAlias!)).toBe(false);
  });
});

describe("filterBootstrapFilesForSession privacy", () => {
  it("prefers authoritative chat type over the session-key fallback", () => {
    const shared = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:opaque:binding",
      chatType: "group",
    });
    const direct = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:discord:channel:c1",
      chatType: "direct",
    });

    expect(shared).toStrictEqual(mockFiles.filter((file) => file.name !== "MEMORY.md"));
    expect(direct).toStrictEqual(mockFiles);
  });

  it("drops root memory path aliases while preserving nested memory in shared sessions", () => {
    const rootMemoryAlias: WorkspaceBootstrapFile = {
      name: "SOUL.md",
      path: "/w/private/../MEMORY.md",
      content: "",
      missing: false,
    };
    const nestedMemory: WorkspaceBootstrapFile = {
      name: "MEMORY.md",
      path: "/w/packages/core/MEMORY.md",
      content: "",
      missing: false,
    };

    const result = filterBootstrapFilesForSession([rootMemoryAlias, nestedMemory], {
      sessionKey: "agent:default:opaque:binding",
      chatType: "channel",
      workspaceDir: "/w",
    });

    expect(result).toStrictEqual([nestedMemory]);
  });

  it.each([
    ["subagent", "agent:default:subagent:task-1", "AGENTS.md"],
    ["cron", "agent:default:cron:daily-check", "SOUL.md"],
  ] as const)(
    "drops root memory path aliases before the %s allowlist",
    (_mode, sessionKey, name) => {
      const allowedFile = mockFiles.find((file) => file.name === name)!;
      const rootMemoryAlias: WorkspaceBootstrapFile = {
        name,
        path: "/w/MEMORY.md",
        content: "",
        missing: false,
      };

      const result = filterBootstrapFilesForSession([allowedFile, rootMemoryAlias], {
        sessionKey,
        workspaceDir: "/w",
      });

      expect(result).toStrictEqual([allowedFile]);
    },
  );
});

describe("loadExtraBootstrapFilesWithDiagnostics", () => {
  const extraTempDirs = useAutoCleanupTempDirTracker(afterEach);
  const createWorkspaceDir = (prefix: string) => extraTempDirs.make(`openclaw-${prefix}-`);

  async function loadExtraBootstrapFileList(dir: string, extraPatterns: string[]) {
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
    return files;
  }

  it("loads recognized bootstrap files from glob patterns", async () => {
    const workspaceDir = createWorkspaceDir("glob");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "SOUL.md"), "soul", "utf-8");
    await fs.writeFile(path.join(packageDir, "README.md"), "not bootstrap", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["./packages/*/*"]);

    expect(files).toStrictEqual([
      {
        name: "SOUL.md",
        path: path.join(packageDir, "SOUL.md"),
        content: "soul",
        missing: false,
      },
    ]);
  });

  it("loads literal bootstrap paths with square brackets", async () => {
    const workspaceDir = createWorkspaceDir("literal-brackets");
    const packageDir = path.join(workspaceDir, "pkg[1]");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "literal agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["pkg[1]/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "literal agents",
        missing: false,
      },
    ]);
  });

  it("keeps path-traversal attempts outside workspace excluded", async () => {
    const rootDir = createWorkspaceDir("root");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["../outside/AGENTS.md"]);

    expect(files).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "falls back to a shallow scan without entering unrelated unreadable branches",
    async () => {
      const workspaceDir = createWorkspaceDir("shallow-pattern");
      const privateDir = path.join(workspaceDir, "packages", "blocked", "node_modules", "private");
      const readableDir = path.join(workspaceDir, "packages", "readable");
      await fs.mkdir(privateDir, { recursive: true });
      await fs.mkdir(readableDir, { recursive: true });
      await fs.writeFile(path.join(privateDir, "AGENTS.md"), "irrelevant", "utf-8");
      await fs.writeFile(path.join(readableDir, "AGENTS.md"), "readable", "utf-8");
      await fs.chmod(privateDir, 0o000);
      const glob = vi.spyOn(fs, "glob").mockImplementation(() => {
        throw new Error("native glob failed");
      });
      const readDirectory = vi.spyOn(fs, "readdir");
      try {
        const result = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
          "packages/*/AGENTS.md",
        ]);
        expect(result.diagnostics).toEqual([]);
        expect(result.files).toEqual([
          expect.objectContaining({ path: path.join(readableDir, "AGENTS.md") }),
        ]);
        expect(readDirectory).not.toHaveBeenCalledWith(privateDir, expect.anything());
      } finally {
        readDirectory.mockRestore();
        glob.mockRestore();
        await fs.chmod(privateDir, 0o700);
      }
    },
  );
});
