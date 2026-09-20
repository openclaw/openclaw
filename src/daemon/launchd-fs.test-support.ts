import fs, { type PathLike } from "node:fs";
import type * as promises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

type LaunchdFileSystemState = {
  fsRoot: string;
  dirs: Set<string>;
  dirModes: Map<string, number>;
  files: Map<string, string>;
  fileModes: Map<string, number>;
  fileWrites: Array<{ path: string; data: string }>;
};

/** Keep the fixture's logical paths while exercising real descriptors and atomic renames. */
export function createLaunchdFileSystem(actual: typeof promises, state: LaunchdFileSystemState) {
  let root = "";
  const materialized = new Map<string, string>();
  const handles = new WeakMap<promises.FileHandle, string>();
  const key = (file: PathLike) =>
    path.posix.normalize(
      (file instanceof URL ? fileURLToPath(file) : file.toString()).replaceAll("\\", "/"),
    );
  const physical = (file: string) => {
    const target = path.resolve(root, key(file).replace(/^\/+/, ""));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error("Logical launchd path escapes its fixture root.");
    }
    return target;
  };
  const readState = (file: string) => {
    const target = physical(file);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
      state.dirs.add(file);
      state.dirModes.set(file, stat.mode & 0o777);
      return;
    }
    const contents = stat.isSymbolicLink()
      ? "dangling-launchagent-symlink"
      : fs.readFileSync(target, "utf8");
    state.files.set(file, contents);
    materialized.set(file, contents);
    state.fileModes.set(file, stat.mode & 0o777);
  };
  const prepare = () => {
    if (root !== state.fsRoot) {
      root = state.fsRoot;
      materialized.clear();
    }
    if (!root) {
      throw new Error("Launchd filesystem fixture has no backing directory.");
    }
    for (const directory of state.dirs) {
      const target = physical(directory);
      fs.mkdirSync(target, { recursive: true });
      const mode = state.dirModes.get(directory);
      if (mode !== undefined && (fs.statSync(target).mode & 0o777) !== mode) {
        fs.chmodSync(target, mode);
      }
    }
    for (const file of materialized.keys()) {
      if (!state.files.has(file)) {
        fs.rmSync(physical(file), { force: true });
        materialized.delete(file);
        state.fileModes.delete(file);
      }
    }
    for (const [file, contents] of state.files) {
      const target = physical(file);
      if (materialized.get(file) !== contents) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (contents === "dangling-launchagent-symlink") {
          fs.rmSync(target, { force: true });
          fs.symlinkSync("missing-launchagent", target);
        } else {
          if (materialized.get(file) === "dangling-launchagent-symlink") {
            fs.unlinkSync(target);
          }
          fs.writeFileSync(target, contents);
        }
        materialized.set(file, contents);
      }
      const mode = state.fileModes.get(file);
      if (
        contents !== "dangling-launchagent-symlink" &&
        mode !== undefined &&
        (fs.statSync(target).mode & 0o777) !== mode
      ) {
        fs.chmodSync(target, mode);
      }
    }
  };
  const resolve = (file: PathLike) => {
    prepare();
    return physical(key(file));
  };
  const recordWrite = (file: string) => {
    readState(file);
    state.fileWrites.push({ path: file, data: state.files.get(file)! });
  };
  const forget = (file: string) => {
    materialized.delete(file);
    state.files.delete(file);
    state.fileModes.delete(file);
  };
  return {
    ...actual,
    access: vi.fn(async (...[file, mode]: Parameters<typeof actual.access>) =>
      actual.access(resolve(file), mode),
    ),
    lstat: vi.fn(async (...[file, options]: Parameters<typeof actual.lstat>) =>
      actual.lstat(resolve(file), options),
    ),
    stat: vi.fn(async (...[file, options]: Parameters<typeof actual.stat>) =>
      actual.stat(resolve(file), options),
    ),
    mkdir: vi.fn(async (...[file, options]: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(resolve(file), options);
      readState(key(file));
      return result;
    }),
    chmod: vi.fn(async (...[file, mode]: Parameters<typeof actual.chmod>) => {
      await actual.chmod(resolve(file), mode);
      readState(key(file));
    }),
    readFile: vi.fn(async (...[file, options]: Parameters<typeof actual.readFile>) =>
      actual.readFile(typeof file === "object" && "fd" in file ? file : resolve(file), options),
    ),
    open: vi.fn(async (...[file, flags, mode]: Parameters<typeof actual.open>) => {
      const handle = await actual.open(resolve(file), flags, mode);
      const logical = key(file);
      handles.set(handle, logical);
      readState(logical);
      const chmod = handle.chmod.bind(handle);
      handle.chmod = async (value) => {
        await chmod(value);
        readState(logical);
      };
      return handle;
    }),
    writeFile: vi.fn(async (...[file, data, options]: Parameters<typeof actual.writeFile>) => {
      if (typeof file === "object" && "fd" in file) {
        const logical = handles.get(file);
        if (logical === undefined) {
          throw new Error("Write used a descriptor outside the launchd filesystem fixture.");
        }
        await actual.writeFile(file, data, options);
        recordWrite(logical);
      } else {
        await actual.writeFile(resolve(file), data, options);
        recordWrite(key(file));
      }
    }),
    unlink: vi.fn(async (file: PathLike) => {
      await actual.unlink(resolve(file));
      forget(key(file));
    }),
    rename: vi.fn(async (from: PathLike, to: PathLike) => {
      const source = resolve(from);
      const target = physical(key(to));
      await actual.rename(source, target);
      forget(key(from));
      recordWrite(key(to));
    }),
  };
}
