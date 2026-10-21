import fs from "node:fs/promises";
import path from "node:path";
import { resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "../sandbox/fs-bridge.js";

export function createSandboxFsBridgeFromResolver(
  resolvePath: (filePath: string, cwd?: string) => SandboxResolvedPath,
  pathMappings?: SandboxFsBridge["pathMappings"],
): SandboxFsBridge {
  const hostPath = (filePath: string, cwd?: string) => {
    const target = resolvePath(filePath, cwd);
    if (!target.hostPath) {
      throw new Error(`Expected hostPath for ${target.containerPath}`);
    }
    return target.hostPath;
  };
  const prepareWrite = async (filePath: string, cwd: string | undefined, mkdir: boolean) => {
    const target = hostPath(filePath, cwd);
    if (mkdir) {
      await fs.mkdir(path.dirname(target), { recursive: true });
    }
    return target;
  };
  const transfer = async (
    operation: "copy" | "rename",
    from: string,
    to: string,
    cwd: string | undefined,
    mkdir = true,
  ) => {
    const source = resolvePath(from, cwd);
    const target = resolvePath(to, cwd);
    if (!source.hostPath || !target.hostPath) {
      throw new Error(
        `Expected hostPath for ${operation}: ${source.containerPath} -> ${target.containerPath}`,
      );
    }
    if (mkdir) {
      await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
    }
    await (operation === "copy" ? fs.copyFile : fs.rename)(source.hostPath, target.hostPath);
  };
  return {
    ...(pathMappings === undefined ? {} : { pathMappings }),
    resolvePath: ({ filePath, cwd }) => resolvePath(filePath, cwd),
    copyFile: ({ sourcePath, destinationPath, cwd, mkdir = true }) =>
      transfer("copy", sourcePath, destinationPath, cwd, mkdir),
    readFile: async ({ filePath, cwd }) => fs.readFile(hostPath(filePath, cwd)),
    writeFile: async ({ filePath, cwd, data, mkdir = true }) => {
      const target = await prepareWrite(filePath, cwd, mkdir);
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await fs.writeFile(target, buffer);
    },
    createFileExclusive: async ({ filePath, cwd, data, mkdir = true }) => {
      const target = await prepareWrite(filePath, cwd, mkdir);
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        await fs.writeFile(target, buffer, { flag: "wx" });
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return "exists";
        }
        throw error;
      }
    },
    mkdirp: async ({ filePath, cwd }) => {
      await fs.mkdir(hostPath(filePath, cwd), { recursive: true });
    },
    remove: async ({ filePath, cwd, recursive, force }) => {
      await fs.rm(hostPath(filePath, cwd), {
        recursive: recursive ?? false,
        force: force ?? false,
      });
    },
    rename: ({ from, to, cwd }) => transfer("rename", from, to, cwd),
    stat: async ({ filePath, cwd }) => {
      try {
        const stats = await fs.stat(hostPath(filePath, cwd));
        return {
          type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        } satisfies SandboxFsStat;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
  };
}

function resolvedPath(hostPath: string, relativePath: string): SandboxResolvedPath {
  return { hostPath, relativePath, containerPath: path.posix.join("/workspace", relativePath) };
}

export function createHostSandboxFsBridge(rootDir: string): SandboxFsBridge {
  const root = path.resolve(rootDir);
  return createSandboxFsBridgeFromResolver(
    (filePath, cwd) => {
      // Operations may receive the container path returned by an earlier resolution.
      const input =
        filePath === "/workspace" || filePath.startsWith("/workspace/")
          ? path.join(root, filePath.slice("/workspace".length))
          : filePath;
      const resolved = resolveSandboxPath({
        filePath: input,
        cwd: cwd ?? root,
        root,
      });
      return resolvedPath(
        resolved.resolved,
        resolved.relative.split(path.sep).filter(Boolean).join(path.posix.sep),
      );
    },
    [{ hostRoot: root, containerRoot: "/workspace" }],
  );
}

export function createContainerWorkspaceSandboxFsBridge(rootDir: string): SandboxFsBridge {
  const root = path.resolve(rootDir);
  return createSandboxFsBridgeFromResolver(
    (filePath, cwd) => {
      const normalized = filePath.replace(/\\/g, "/");
      const relativePath = normalized.startsWith("/workspace/")
        ? normalized.slice("/workspace/".length)
        : normalized === "/workspace" || path.resolve(filePath) === root
          ? ""
          : path.relative(root, path.resolve(cwd ?? root, filePath)).replace(/\\/g, "/");
      return resolvedPath(path.join(root, relativePath), relativePath);
    },
    [{ hostRoot: root, containerRoot: "/workspace" }],
  );
}
