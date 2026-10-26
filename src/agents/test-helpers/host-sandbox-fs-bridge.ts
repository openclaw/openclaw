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
    operation: typeof fs.copyFile | typeof fs.rename,
    from: string,
    to: string,
    cwd: string | undefined,
    mkdir = true,
  ) => {
    const source = hostPath(from, cwd);
    await operation(source, await prepareWrite(to, cwd, mkdir));
  };
  return {
    ...(pathMappings === undefined ? {} : { pathMappings }),
    resolvePath: ({ filePath, cwd }) => resolvePath(filePath, cwd),
    copyFile: ({ sourcePath, destinationPath, cwd, mkdir = true }) =>
      transfer(fs.copyFile, sourcePath, destinationPath, cwd, mkdir),
    readFile: async ({ filePath, cwd }) => fs.readFile(hostPath(filePath, cwd)),
    writeFile: async ({ filePath, cwd, data, mkdir = true }) => {
      await fs.writeFile(await prepareWrite(filePath, cwd, mkdir), data);
    },
    createFileExclusive: async ({ filePath, cwd, data, mkdir = true }) => {
      const target = await prepareWrite(filePath, cwd, mkdir);
      try {
        await fs.writeFile(target, data, { flag: "wx" });
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
    rename: ({ from, to, cwd }) => transfer(fs.rename, from, to, cwd),
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
