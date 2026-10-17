import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

/** Keep real files/inodes; project only the privileges unavailable to CI workers. */
export function immutableLayout(
  parent: string,
  options: {
    sha: string;
    buildDigest: string;
    unit: string;
    account: string;
    externalRuntime?: boolean;
    ownParent?: boolean;
  },
): ImmutableInstallDescriptor {
  const root = path.join(parent, "installation");
  const currentPath = path.join(root, "releases", options.sha);
  fs.mkdirSync(currentPath, { recursive: true, mode: 0o755 });
  fs.symlinkSync(`releases/${options.sha}`, path.join(root, "current"));
  const runtime = options.externalRuntime
    ? path.join(parent, "node")
    : fs.realpathSync(process.execPath);
  if (options.externalRuntime) {
    fs.writeFileSync(runtime, "synthetic external runtime", { mode: 0o755 });
  }
  const parents = new Set<string>();
  if (options.externalRuntime) {
    for (let entry = parent; ; entry = path.dirname(entry)) {
      parents.add(entry);
      if (entry === path.dirname(entry)) {
        break;
      }
    }
  }
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    const file = String(args[0]);
    if (
      stat &&
      (parents.has(file) ||
        (options.ownParent && file === parent) ||
        file.startsWith(`${parent}${path.sep}`))
    ) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
      if (parents.has(file)) {
        Object.defineProperty(stat, "mode", {
          value: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022,
        });
      }
    }
    return stat;
  });
  if (options.externalRuntime) {
    const lstatAsync = fsAsync.lstat;
    vi.spyOn(fsAsync, "lstat").mockImplementation(async (...args) => {
      const stat = await lstatAsync(...args);
      if (String(args[0]) === runtime) {
        Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
      }
      return stat;
    });
  }
  if (process.geteuid) {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
  }
  return {
    version: 1,
    kind: "immutable",
    root,
    rootIdentity: identity(root),
    releasesIdentity: identity(path.join(root, "releases")),
    current: {
      sha: options.sha,
      path: currentPath,
      identity: identity(currentPath),
      pointerIdentity: identity(path.join(root, "current")),
      buildDigest: options.buildDigest,
    },
    service: {
      unit: options.unit,
      scope: "system",
      account: options.account,
      stateDir: path.join(parent, "state"),
      configPath: path.join(parent, "state", "openclaw.json"),
      profile: null,
    },
    runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
    source: "https://github.com/openclaw/openclaw.git",
  };
}

export function identity(file: string) {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

export function expectUncalled(...mocks: { mock: { calls: readonly unknown[] } }[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
