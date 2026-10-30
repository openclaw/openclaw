import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

async function agentsWorkspace(content: string) {
  const dir = await makeTempWorkspace("openclaw-workspace-");
  await writeWorkspaceFile({ dir, name: DEFAULT_AGENTS_FILENAME, content });
  return dir;
}

async function expectAgents(dir: string, content: string, exact = false) {
  const files = await loadWorkspaceBootstrapFiles(dir);
  expect(files.find((file) => file.name === DEFAULT_AGENTS_FILENAME)).toMatchObject({
    missing: false,
    content: exact ? content : expect.stringContaining(content),
  });
}

export function registerWorkspaceBootstrapTests() {
  describe("loadWorkspaceBootstrapFiles", () => {
    const getMemoryEntries = (files: Awaited<ReturnType<typeof loadWorkspaceBootstrapFiles>>) =>
      files.filter((file) => file.name === DEFAULT_MEMORY_FILENAME);

    it.each(["MEMORY.md", "memory.md", undefined])(
      "loads exact optional memory: %s",
      async (name) => {
        const tempDir = await makeTempWorkspace("openclaw-workspace-");
        if (name) {
          await writeWorkspaceFile({ dir: tempDir, name, content: "memory" });
        }
        const entries = getMemoryEntries(await loadWorkspaceBootstrapFiles(tempDir));
        expect(entries).toMatchObject(
          name === "MEMORY.md" ? [{ missing: false, content: "memory" }] : [],
        );
        expect(entries).toHaveLength(name === "MEMORY.md" ? 1 : 0);
      },
    );

    it("treats hardlinked bootstrap aliases as unreadable", async () => {
      if (process.platform === "win32") {
        return;
      }
      const rootDir = await makeTempWorkspace("openclaw-workspace-hardlink-");
      try {
        const workspaceDir = path.join(rootDir, "workspace");
        const outsideDir = path.join(rootDir, "outside");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, DEFAULT_AGENTS_FILENAME);
        const linkPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
        await fs.writeFile(outsideFile, "outside", "utf-8");
        try {
          await fs.link(outsideFile, linkPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }

        await expectAgents(workspaceDir, "[UNREADABLE: path must not be hardlinked]", true);
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });

    it("retries a transient bootstrap read instead of dropping the file for the turn", async () => {
      const tempDir = await agentsWorkspace("# AGENTS.md\n\nkeep me\n");

      // The bounded fd reader consumes the descriptor via fs.read; inject the
      // transient failure at that seam.
      const originalRead = syncFs.read.bind(syncFs);
      let readCalls = 0;
      let threwTransient = false;
      vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
        readCalls += 1;
        if (!threwTransient) {
          threwTransient = true;
          const callback = args.at(-1) as (error: Error) => void;
          callback(
            Object.assign(new Error("Unknown system error -11: read"), {
              code: "EAGAIN",
              errno: -11,
            }),
          );
          return;
        }
        (originalRead as (...forwarded: unknown[]) => void)(...args);
      }) as typeof syncFs.read);

      await expectAgents(tempDir, "keep me");
      expect(threwTransient).toBe(true);
      // The retry re-opens and reads again, so the failed first read is followed
      // by at least one more successful read.
      expect(readCalls).toBeGreaterThanOrEqual(2);
    });

    it("marks a bootstrap file unreadable after transient read retries are exhausted", async () => {
      const tempDir = await agentsWorkspace("# AGENTS.md\n");

      vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void;
        callback(
          Object.assign(new Error("Unknown system error -11: read"), {
            code: "EAGAIN",
            errno: -11,
          }),
        );
      }) as typeof syncFs.read);

      await expectAgents(tempDir, "[UNREADABLE: Unknown system error -11: read]", true);
    });

    it("retries a transient boundary-resolution failure before dropping a bootstrap file", async () => {
      const tempDir = await agentsWorkspace("# AGENTS.md\n\nboundary retry\n");

      const agentsPath = path.join(syncFs.realpathSync(tempDir), DEFAULT_AGENTS_FILENAME);
      const originalLstat = syncFs.lstatSync.bind(syncFs);
      let agentsLstatAttempts = 0;
      vi.spyOn(syncFs, "lstatSync").mockImplementation(((target: unknown, options?: unknown) => {
        if (String(target) === agentsPath && ++agentsLstatAttempts === 1) {
          throw Object.assign(new Error("Unknown system error -11: lstat"), {
            code: "EAGAIN",
            errno: -11,
          });
        }
        return originalLstat(target as never, options as never);
      }) as typeof syncFs.lstatSync);

      await expectAgents(tempDir, "boundary retry");
      expect(agentsLstatAttempts).toBeGreaterThanOrEqual(2);
    });

    it("retries a transient open failure before dropping a bootstrap file", async () => {
      const tempDir = await agentsWorkspace("# AGENTS.md\n\nopen retry\n");

      // openRootFile reports a transient open failure as reason "io"; the reader
      // must retry it (re-open) rather than drop the file for the turn.
      const originalOpenSync = syncFs.openSync.bind(syncFs);
      let threwTransientOpen = false;
      vi.spyOn(syncFs, "openSync").mockImplementation(((
        ...args: Parameters<typeof syncFs.openSync>
      ) => {
        if (!threwTransientOpen) {
          threwTransientOpen = true;
          throw Object.assign(new Error("Unknown system error -11: open"), {
            code: "EAGAIN",
            errno: -11,
          });
        }
        return originalOpenSync(...args);
      }) as typeof syncFs.openSync);

      await expectAgents(tempDir, "open retry");
      expect(threwTransientOpen).toBe(true);
    });
  });

  describe("filterBootstrapFilesForSession", () => {
    const mockFiles = (
      ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"] as const
    ).map((name): WorkspaceBootstrapFile => ({
      name,
      path: `/w/${name}`,
      content: "",
      missing: false,
    }));

    it.each([
      [undefined, mockFiles],
      ["agent:default:chat:main", mockFiles],
      ["agent:default:subagent:task-1", mockFiles.slice(0, 1)],
      ["agent:default:cron:daily-check", mockFiles.slice(0, 4)],
    ] as const)("filters bootstrap files for %s", (session, expected) => {
      expect(filterBootstrapFilesForSession(mockFiles, session)).toStrictEqual(expected);
    });
  });
}
