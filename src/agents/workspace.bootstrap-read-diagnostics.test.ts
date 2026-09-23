import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("rejects remote bootstrap content when access is revoked during the read", async () => {
    const tempDir = tempDirs.make("openclaw-remote-workspace-");
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "stale local document");
    let release = () => {};
    const bridge: AgentWorkspaceAccess["bridge"] = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      readFileWithSource: vi.fn(async () => {
        release();
        return {
          data: Buffer.from("remote document"),
          canonicalPath: "/remote/AGENTS.md",
        };
      }),
    };
    release = registerAgentWorkspaceAccess(tempDir, { bridge });
    try {
      await expect(loadWorkspaceBootstrapFiles(tempDir)).rejects.toThrow(/Workspace access/);
    } finally {
      release();
    }
  });

  it("requires remote bootstrap provenance without falling back to byte-only or local reads", async () => {
    const tempDir = tempDirs.make("openclaw-remote-workspace-no-source-");
    await fs.writeFile(path.join(tempDir, DEFAULT_AGENTS_FILENAME), "stale local document");
    const readFile = vi.fn(async () => Buffer.from("unattributed remote document"));
    const stat = vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>();
    const bridge: AgentWorkspaceAccess["bridge"] = {
      readFile,
      writeFile: vi.fn(),
      stat,
    };
    const release = registerAgentWorkspaceAccess(tempDir, { bridge });
    try {
      await expect(loadWorkspaceBootstrapFiles(tempDir)).rejects.toThrow(
        "Workspace bootstrap source identity is unavailable",
      );
      expect(readFile).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

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
