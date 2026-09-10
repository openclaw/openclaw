import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  readSupervisedWorkspaceFile,
  resolveSupervisedWorkspaceFile,
  type SupervisedWorkspaceSnapshot,
} from "./supervised-workspace.js";

const execute = promisify(execFile);
export type AssertCurrent = () => void;

export async function step<T>(assertCurrent: AssertCurrent, action: () => Promise<T>): Promise<T> {
  assertCurrent();
  const value = await action();
  assertCurrent();
  return value;
}

export async function mount(argv: string[], assertCurrent: AssertCurrent) {
  await step(assertCurrent, () =>
    execute("/usr/bin/mount", argv, {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    }),
  );
}

export function isWithin(root: string, selected: string) {
  return selected === root || selected.startsWith(root === "/" ? "/" : `${root}/`);
}

export async function assertDirectory(directory: string, assertCurrent: AssertCurrent) {
  const resolved = await step(assertCurrent, () => fs.realpath(directory));
  const stat = await step(assertCurrent, () => fs.lstat(directory));
  if (resolved !== directory || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("Command allocation must be a canonical private directory");
  }
  return stat;
}

/** Source and destination are trusted directory identities, not payload-owned
 * paths. Before launch / after extinction is required for every caller. */
export async function copyManifest(params: {
  source: string;
  destination: string;
  snapshot: SupervisedWorkspaceSnapshot;
  assertCurrent: AssertCurrent;
}) {
  const { source, destination, snapshot, assertCurrent } = params;
  for (const file of snapshot.files) {
    const target = path.resolve(destination, file.path);
    if (!isWithin(destination, target) || target === destination) {
      throw new Error("Command manifest escaped its destination");
    }
    const bytes = await step(assertCurrent, () =>
      readSupervisedWorkspaceFile(source, file.path, file.bytes),
    );
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new Error("Command source changed during manifest copy");
    }
    await step(assertCurrent, () =>
      fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }),
    );
    await step(assertCurrent, () =>
      fs.writeFile(target, bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 }),
    );
  }
}

export async function copySelectedDirectories(
  source: string,
  destination: string,
  sourcePaths: string[],
  assertCurrent: AssertCurrent,
) {
  for (const selected of sourcePaths) {
    const resolved = await step(assertCurrent, () =>
      resolveSupervisedWorkspaceFile(source, selected),
    );
    const stat = await step(assertCurrent, () => fs.lstat(resolved));
    if (stat.isDirectory()) {
      await step(assertCurrent, () =>
        fs.mkdir(path.join(destination, path.relative(source, resolved)), {
          recursive: true,
          mode: 0o700,
        }),
      );
    }
  }
}
