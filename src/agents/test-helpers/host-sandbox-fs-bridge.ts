import fs from "node:fs/promises";
import path from "node:path";
import { resolveSandboxPath } from "../sandbox-paths.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "../sandbox/fs-bridge.js";

/** Creates a sandbox fs bridge from a caller-provided path resolver. */
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
  return {
    ...(pathMappings === undefined ? {} : { pathMappings }),
    resolvePath: ({ filePath, cwd }) => resolvePath(filePath, cwd),
    copyFile: async ({ sourcePath, destinationPath, cwd, mkdir = true }) => {
      const source = resolvePath(sourcePath, cwd);
      const destination = resolvePath(destinationPath, cwd);
      if (!source.hostPath || !destination.hostPath) {
        throw new Error(
          `Expected hostPath for copy: ${source.containerPath} -> ${destination.containerPath}`,
        );
      }
      if (mkdir) {
        await fs.mkdir(path.dirname(destination.hostPath), { recursive: true });
      }
      await fs.copyFile(source.hostPath, destination.hostPath);
    },
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
    rename: async ({ from, to, cwd }) => {
      const source = resolvePath(from, cwd);
      const target = resolvePath(to, cwd);
      if (!source.hostPath || !target.hostPath) {
        throw new Error(
          `Expected hostPath for rename: ${source.containerPath} -> ${target.containerPath}`,
        );
      }
      await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
      await fs.rename(source.hostPath, target.hostPath);
    },
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

/** Creates a sandbox fs bridge rooted at a real host directory. */
export function createHostSandboxFsBridge(rootDir: string): SandboxFsBridge {
  const root = path.resolve(rootDir);

  const resolvePath = (filePath: string, cwd?: string): SandboxResolvedPath => {
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
    const relativePath = resolved.relative
      ? resolved.relative.split(path.sep).filter(Boolean).join(path.posix.sep)
      : "";
    const containerPath = relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
    return {
      hostPath: resolved.resolved,
      relativePath,
      containerPath,
    };
  };

  return createSandboxFsBridgeFromResolver(resolvePath, [
    { hostRoot: root, containerRoot: "/workspace" },
  ]);
}

/** Creates a host-backed bridge that accepts the Docker-style /workspace mount path. */
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
      return {
        hostPath: path.join(root, relativePath),
        relativePath,
        containerPath: relativePath ? path.posix.join("/workspace", relativePath) : "/workspace",
      };
    },
    [{ hostRoot: root, containerRoot: "/workspace" }],
  );
}
