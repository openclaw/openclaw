import { createHash } from "node:crypto";
import { closeSync, fstatSync, read } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile } from "../infra/boundary-file-read.js";
import type { SupervisedWorkflowProfile } from "./supervised-workflow.types.js";

type Command = Extract<SupervisedWorkflowProfile, { kind: "command" }>;

/** Observe accepted regular-file inputs before and after a command. Host
 * platform libraries remain trusted; this is not a filesystem rollback guard. */
export async function openSupervisedCommandInputs(profile: Command, workspace: string) {
  const handles: Array<{ fd: number; path: string; hash: string; maxBytes: number }> = [];
  const close = () => {
    for (const handle of handles.splice(0)) {
      closeSync(handle.fd);
    }
  };
  const verify = async () => {
    for (const handle of handles) {
      const before = fstatSync(handle.fd);
      // Positional reads preserve the descriptor offset for repeated checks and
      // hash large runtimes without allocating their entire contents at once.
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const count = await new Promise<number>((resolve, reject) => {
          read(
            handle.fd,
            buffer,
            0,
            Math.min(buffer.length, handle.maxBytes - size + 1),
            size,
            (error, bytesRead) => (error ? reject(error) : resolve(bytesRead)),
          );
        });
        if (!count) {
          break;
        }
        size += count;
        if (size > handle.maxBytes) {
          throw new Error("Accepted command input exceeds its byte budget");
        }
        digest.update(buffer.subarray(0, count));
      }
      const after = fstatSync(handle.fd);
      const selected = await fs.lstat(handle.path);
      if (
        selected.isSymbolicLink() ||
        selected.dev !== before.dev ||
        selected.ino !== before.ino ||
        before.size !== size ||
        before.nlink !== 1 ||
        after.nlink !== 1 ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        digest.digest("hex") !== handle.hash
      ) {
        throw new Error("Accepted command input changed or does not match its pinned digest");
      }
    }
  };
  try {
    for (const input of [
      { path: profile.executable, sha256: profile.executableSha256, maxBytes: 256 * 1024 * 1024 },
      ...profile.readOnlyPaths.map((selectedInput) => ({
        ...selectedInput,
        maxBytes: 8 * 1024 * 1024,
      })),
    ]) {
      if (
        input.path === workspace ||
        input.path.startsWith(`${workspace}${path.sep}`) ||
        ["/work", "/runtime", "/proc", "/dev"].some(
          (root) => input.path === root || input.path.startsWith(`${root}/`),
        )
      ) {
        throw new Error("Accepted command input overlaps a reserved sandbox boundary");
      }
      const opened = await openRootFile({
        rootPath: path.dirname(input.path),
        absolutePath: input.path,
        maxBytes: input.maxBytes,
        rejectHardlinks: true,
        boundaryLabel: "accepted command input",
      });
      if (!opened.ok) {
        throw new Error("Accepted command input is unavailable or fails its regular-file boundary");
      }
      handles.push({
        fd: opened.fd,
        path: input.path,
        hash: input.sha256,
        maxBytes: input.maxBytes,
      });
    }
    await verify();
    return {
      mounts: handles.map((handle, index) => ({
        source: handle.path,
        target: index === 0 ? "/runtime/command" : handle.path,
      })),
      hash: createHash("sha256")
        .update(
          JSON.stringify(handles.map(({ path: inputPath, hash }) => ({ path: inputPath, hash }))),
        )
        .digest("hex"),
      verify,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
