// Remote extra-bootstrap discovery/read parity: proves the hardened discovery
// stays bridge-owned when workspace access is registered. A registered mock
// access serves directory listings and file contents from in-memory fixtures;
// the gateway-local tree holds divergent decoys so any accidental local fs use
// (fs.glob / fs.readdir) surfaces as a wrong-tree result. Mirrors the bridge
// fixtures of bootstrap-files.remote.test.ts with a pure mock bridge so the
// assertions target the access-gated discovery owner directly.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import bootstrapExtraFilesHook from "../hooks/bundled/bootstrap-extra-files/handler.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
} from "../hooks/internal-hooks.js";
import type { AgentWorkspaceAccess } from "./workspace-access.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

// A shared mock logger keeps the real level gate out of the warn assertion while
// preserving every other subsystem export the workspace graph imports.
const logSpies = vi.hoisted(() => {
  const make = () => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => logger),
    };
    return logger;
  };
  return make();
});

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return { ...actual, createSubsystemLogger: () => logSpies };
});

type FileTree = Record<string, string>;

type MockBridge = AgentWorkspaceAccess["bridge"] & {
  readDirectory: ReturnType<typeof vi.fn>;
  readFileWithSource: ReturnType<typeof vi.fn>;
};

function posix(relativePath: string): string {
  return relativePath.replaceAll(path.sep, "/");
}

function enoent(relativePath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: ${relativePath}`);
  error.code = "ENOENT";
  return error;
}

/**
 * In-memory bridge over a POSIX-relative file map. readDirectory derives the
 * immediate children of a relative directory; readFileWithSource returns the
 * fixture bytes with a synthetic canonical path. Per-path read faults model the
 * io-isolation and assertCurrent flows.
 */
function createMockBridge(
  tree: FileTree,
  options: {
    failRead?: (relativePath: string) => Error | undefined;
    onReadFileWithSource?: (relativePath: string) => void;
  } = {},
): MockBridge {
  const readDirectory = vi.fn(async ({ filePath }: { filePath: string }) => {
    const dir = filePath === "." ? "" : posix(filePath);
    const prefix = dir ? `${dir}/` : "";
    const children = new Map<string, boolean>();
    for (const entry of Object.keys(tree)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const rest = entry.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        children.set(rest, false);
      } else {
        children.set(rest.slice(0, slash), true);
      }
    }
    return [...children].map(([name, isDirectory]) => ({
      name,
      isDirectory,
      isFile: !isDirectory,
    }));
  });

  const readFileWithSource = vi.fn(async ({ filePath }: { filePath: string }) => {
    const relativePath = posix(filePath);
    options.onReadFileWithSource?.(relativePath);
    const failure = options.failRead?.(relativePath);
    if (failure) {
      throw failure;
    }
    const content = tree[relativePath];
    if (content === undefined) {
      throw enoent(relativePath);
    }
    const data = Buffer.from(content, "utf-8");
    return {
      data,
      canonicalPath: `/remote-workspace/${relativePath}`,
      workspaceRelativePath: relativePath,
    };
  });

  return {
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ type: "file" as const, size: 0, mtimeMs: 0 })),
    readDirectory,
    readFileWithSource,
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let gatewayDir: string;
let release: (() => void) | undefined;

function bind(bridge: MockBridge): () => void {
  release = registerAgentWorkspaceAccess(gatewayDir, { bridge });
  return release;
}

async function writeLocalDecoy(relativePath: string, content: string): Promise<void> {
  const target = path.join(gatewayDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

function names(files: Array<{ name: string }>): string[] {
  return files.map((file) => file.name).toSorted();
}

describe.runIf(process.platform !== "win32")(
  "remote extra-bootstrap discovery (mock bridge)",
  () => {
    beforeEach(() => {
      release = undefined;
      gatewayDir = tempDirs.make("remote-extra-gateway-");
      logSpies.warn.mockClear();
      logSpies.debug.mockClear();
    });

    afterEach(() => {
      release?.();
      release = undefined;
    });

    it("discovers extra files through the bridge and never through local fs", async () => {
      // Gateway decoy is a VALID bootstrap basename that only exists locally; if
      // discovery touched fs.glob/fs.readdir it would surface here.
      await writeLocalDecoy("SOUL.md", "local decoy soul");
      const bridge = createMockBridge({ "AGENTS.md": "remote agents" });
      bind(bridge);

      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(gatewayDir, [
        "*.md",
      ]);

      expect(bridge.readDirectory).toHaveBeenCalled();
      expect(names(files)).toEqual(["AGENTS.md"]);
      expect(files[0]?.content).toBe("remote agents");
      // The local-only decoy must not leak into the remote result set.
      expect(files.some((file) => file.content === "local decoy soul")).toBe(false);
      expect(diagnostics).toEqual([]);
    });

    it("reads matched files through bridge.readFileWithSource", async () => {
      const bridge = createMockBridge({ "AGENTS.md": "remote agents" });
      bind(bridge);

      const { files } = await loadExtraBootstrapFilesWithDiagnostics(gatewayDir, ["AGENTS.md"]);

      expect(bridge.readFileWithSource).toHaveBeenCalledTimes(1);
      expect(bridge.readFileWithSource.mock.calls[0]?.[0]).toMatchObject({
        filePath: "AGENTS.md",
        maxBytes: expect.any(Number),
      });
      expect(files).toMatchObject([{ name: "AGENTS.md", content: "remote agents" }]);
    });

    it("rejects a guarded read when workspace access flips mid-await", async () => {
      let flipped = false;
      const bridge = createMockBridge(
        { "AGENTS.md": "remote agents" },
        {
          onReadFileWithSource: () => {
            if (flipped) {
              return;
            }
            flipped = true;
            // Replace the binding during the awaited read: release the current
            // access and register a fresh one so getAgentWorkspaceAccess returns a
            // different object, tripping the loader's post-await assertCurrent.
            release?.();
            release = registerAgentWorkspaceAccess(gatewayDir, {
              bridge: createMockBridge({ "AGENTS.md": "successor" }),
            });
          },
        },
      );
      bind(bridge);

      await expect(
        loadExtraBootstrapFilesWithDiagnostics(gatewayDir, ["AGENTS.md"]),
      ).rejects.toThrow(/Workspace access changed/);
      expect(bridge.readFileWithSource).toHaveBeenCalledTimes(1);
    });

    it("isolates a per-match io failure on the bridge path", async () => {
      const bridge = createMockBridge(
        { "AGENTS.md": "remote agents", "SOUL.md": "remote soul" },
        {
          failRead: (relativePath) => {
            if (relativePath === "SOUL.md") {
              const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
              error.code = "EACCES";
              return error;
            }
            return undefined;
          },
        },
      );
      bind(bridge);

      const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(gatewayDir, [
        "*.md",
      ]);

      // The readable sibling still loads; the failing match is its own io record.
      expect(names(files)).toEqual(["AGENTS.md"]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ reason: "io" });
      expect(posix(diagnostics[0]?.path ?? "")).toMatch(/\/SOUL\.md$/);
    });

    it("surfaces operator warnings on the bridge path", async () => {
      const bridge = createMockBridge(
        { "AGENTS.md": "remote agents", "SOUL.md": "remote soul" },
        {
          failRead: (relativePath) => {
            if (relativePath === "SOUL.md") {
              const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
              error.code = "EACCES";
              return error;
            }
            return undefined;
          },
        },
      );
      bind(bridge);

      const cfg: OpenClawConfig = {
        hooks: {
          internal: { entries: { "bootstrap-extra-files": { enabled: true, paths: ["*.md"] } } },
        },
      };
      const context: AgentBootstrapHookContext = {
        workspaceDir: gatewayDir,
        bootstrapFiles: [],
        cfg,
        sessionKey: "agent:main:main",
      };
      const event = createInternalHookEvent("agent", "bootstrap", "agent:main:main", context);

      await bootstrapExtraFilesHook(event);

      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("resolution failed for 1 path(s)"),
        expect.objectContaining({ reasons: expect.objectContaining({ io: 1 }) }),
      );
      // The readable match still reached the context.
      expect(context.bootstrapFiles.map((file) => file.name)).toEqual(["AGENTS.md"]);
    });

    it("keeps the bridge as discovery authority when local fs.glob is absent", async () => {
      // The local fallback walker switches on `typeof fs.glob === "function"`.
      // Remove it to reproduce the exact runtime condition that would route a
      // local workspace to the Minimatch fallback, and prove a bridge-registered
      // workspace still lists through readDirectory rather than the local tree.
      const descriptor = Object.getOwnPropertyDescriptor(fs, "glob");
      Object.defineProperty(fs, "glob", { configurable: true, value: undefined });
      try {
        await writeLocalDecoy(path.join("packages", "local-only", "AGENTS.md"), "local only");
        const bridge = createMockBridge({ "packages/remote-only/AGENTS.md": "remote only" });
        bind(bridge);

        const { files } = await loadExtraBootstrapFilesWithDiagnostics(gatewayDir, [
          "packages/*/AGENTS.md",
        ]);

        expect(bridge.readDirectory).toHaveBeenCalled();
        expect(files).toHaveLength(1);
        expect(files[0]?.content).toBe("remote only");
        expect(posix(files[0]?.path ?? "")).toMatch(/packages\/remote-only\/AGENTS\.md$/);
        // The local-only tree must not be consulted.
        expect(files.some((file) => file.content === "local only")).toBe(false);
      } finally {
        if (descriptor) {
          Object.defineProperty(fs, "glob", descriptor);
        }
      }
    });

    it("resolves identical file sets and diagnostics under local fs and bridge", async () => {
      const tree: FileTree = {
        "packages/a/AGENTS.md": "agents a",
        "packages/b/AGENTS.md": "agents b",
        "packages/a/README.md": "ignored readme",
      };
      const pattern = "packages/*/AGENTS.md";

      // Local access: materialize the tree on disk, no bridge registered.
      const localDir = tempDirs.make("remote-extra-local-");
      for (const [relativePath, content] of Object.entries(tree)) {
        const target = path.join(localDir, relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf-8");
      }
      const localResult = await loadExtraBootstrapFilesWithDiagnostics(localDir, [pattern]);

      // Remote access: identical logical tree served by the bridge.
      bind(createMockBridge(tree));
      const remoteResult = await loadExtraBootstrapFilesWithDiagnostics(gatewayDir, [pattern]);

      const normalize = (dir: string, result: typeof localResult) => ({
        files: result.files
          .map((file) => ({
            name: file.name,
            content: file.content,
            relativePath: posix(path.relative(dir, file.path)),
          }))
          .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
        diagnostics: result.diagnostics
          .map((diagnostic) => ({
            reason: diagnostic.reason,
            relativePath: posix(path.relative(dir, diagnostic.path)),
          }))
          .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
      });

      const local = normalize(localDir, localResult);
      const remote = normalize(gatewayDir, remoteResult);
      expect(remote).toEqual(local);
      expect(local.files.map((file) => file.relativePath)).toEqual([
        "packages/a/AGENTS.md",
        "packages/b/AGENTS.md",
      ]);
      expect(local.diagnostics).toEqual([]);
    });
  },
);
