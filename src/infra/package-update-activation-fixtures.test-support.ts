import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

export const readBytes = (...parts: string[]) => fs.readFileSync(path.join(...parts));
export const readText = (...parts: string[]) => readBytes(...parts).toString("utf8");
export const fileIdentity = (file: string) => {
  const { dev, ino } = fs.lstatSync(file, { bigint: true });
  return `${dev}:${ino}`;
};

// Only uid is synthetic; permissions, links, bytes and filesystem identities stay real.
export function ownImmutableFixture(parent: string, includeParent = false) {
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    const file = String(args[0]);
    if (stat && ((includeParent && file === parent) || file.startsWith(`${parent}${path.sep}`))) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
}

export function immutableDescriptor(
  root: string,
  sha: string,
  buildDigest: string,
  service: ImmutableInstallDescriptor["service"],
  pointerIdentity = fileIdentity(path.join(root, "current")),
): ImmutableInstallDescriptor {
  const current = path.join(root, "releases", sha);
  const runtime = fs.realpathSync(process.execPath);
  return {
    version: 1,
    kind: "immutable",
    root,
    rootIdentity: fileIdentity(root),
    releasesIdentity: fileIdentity(path.join(root, "releases")),
    current: { sha, path: current, identity: fileIdentity(current), pointerIdentity, buildDigest },
    service,
    runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
    source: "https://github.com/openclaw/openclaw.git",
  };
}

export function withDatabase<T>(file: string, body: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return body(db);
  } finally {
    db.close();
  }
}

export const historicalJson = (value: unknown) =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" && /^\d+:\d+$/u.test(entry)
      ? entry.replace(/^\d+/u, (device) => String(BigInt(device) + 1n))
      : entry,
  );
