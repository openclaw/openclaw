import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import {
  isPathInsideWithRealpath,
  normalizeWindowsPathForComparison,
} from "@openclaw/fs-safe/path";

type SecureTempResolver = typeof import("@openclaw/fs-safe/temp").resolveSecureTempRoot;
type Binding = Readonly<{
  directory: string;
  databasePath: string;
  device: string;
  inode: string;
}>;

const helperUrl = import.meta.url;
const sharedRoots = new Set(["/tmp/openclaw", "/private/tmp/openclaw"]);
const comparisonPath = (value: string) =>
  process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
const forbiddenBindingRoots = new Set(
  [
    ...sharedRoots,
    path.join(tmpdir(), process.getuid ? `openclaw-${process.getuid()}` : "openclaw"),
  ].map(comparisonPath),
);

function privateDirectory(directory: string) {
  assert(
    !forbiddenBindingRoots.has(comparisonPath(directory)),
    "Shared handoff test directory is forbidden",
  );
  assert(path.isAbsolute(directory), "Handoff test directory must be absolute");
  assert.equal(path.resolve(directory), directory, "Handoff test directory must be normalized");
  const stat = fs.lstatSync(directory, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Handoff test directory must be real");
  if (process.platform === "win32") {
    assert(stat.dev !== 0n && stat.ino !== 0n, "Handoff test directory identity is unavailable");
  }
  assert.equal(fs.realpathSync(directory), directory, "Handoff test directory alias is forbidden");
  assert(
    isPathInsideWithRealpath(directory, directory, { requireRealpath: true }),
    "Handoff test directory namespace alias is forbidden",
  );
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o077n, 0n, "Handoff test directory must be private");
    if (process.getuid) {
      assert.equal(stat.uid, BigInt(process.getuid()), "Handoff test directory owner changed");
    }
  }
  return stat;
}

/** Validate the caller-owned directory and every SQLite filename before native open. */
function assertManagedHandoffTestPath(binding: Binding, databasePath = binding.databasePath) {
  assert.equal(databasePath, path.join(binding.directory, "managed-update-handoffs.sqlite"));
  assert.equal(databasePath, binding.databasePath, "Handoff test database changed");
  const stat = privateDirectory(binding.directory);
  assert.equal(String(stat.dev), binding.device, "Handoff test directory device changed");
  assert.equal(String(stat.ino), binding.inode, "Handoff test directory identity changed");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = databasePath + suffix;
    let entry;
    try {
      entry = fs.lstatSync(file);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    assert(entry.isFile() && !entry.isSymbolicLink(), "Handoff test database alias is forbidden");
    assert.equal(entry.nlink, 1, "Handoff test database hardlink is forbidden");
    assert.equal(
      fs.realpathSync(file),
      file,
      "Handoff test database escaped its private directory",
    );
  }
  return databasePath;
}

function writeExactPrivateModule(file: string, source: string) {
  try {
    fs.writeFileSync(file, source, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Test preload alias");
    assert.equal(fs.readFileSync(file, "utf8"), source, "Test preload bytes changed");
  }
}

/** The fixture lifetime owns this directory until all consumers have joined. */
export function createManagedHandoffTestBinding(directory: string) {
  const stat = privateDirectory(directory);
  const binding: Binding = Object.freeze({
    directory,
    databasePath: path.join(directory, "managed-update-handoffs.sqlite"),
    device: String(stat.dev),
    inode: String(stat.ino),
  });
  assertManagedHandoffTestPath(binding);
  const preloadPath = path.join(directory, "handoff-resolver-preload.mjs");
  writeExactPrivateModule(
    preloadPath,
    `import { installManagedHandoffTestBinding } from ${JSON.stringify(helperUrl)};\n` +
      `installManagedHandoffTestBinding(${JSON.stringify(binding)});\n`,
  );
  return {
    ...binding,
    nodeOption: `--import=${pathToFileURL(preloadPath).href}`,
    assertPath: (databasePath = binding.databasePath) =>
      assertManagedHandoffTestPath(binding, databasePath),
  };
}

/** Explicit argv/source binding survives replaced env and deleted NODE_OPTIONS. */
export function installManagedHandoffTestBinding(binding: Binding) {
  assertManagedHandoffTestPath(binding);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const original = nextResolve(specifier, context);
      if (specifier !== "@openclaw/fs-safe/temp") {
        return original;
      }
      assertManagedHandoffTestPath(binding);
      // Resolve at the consumer's package boundary, never through the parent's dependencies.
      const consumer = context.parentURL ?? "";
      const phase = consumer === helperUrl ? "preload" : "consumer";
      const id = createHash("sha256").update(`${original.url}\0${consumer}`).digest("hex");
      const shim = path.join(binding.directory, `fs-safe-temp-${id}.mjs`);
      writeExactPrivateModule(
        shim,
        `export * from ${JSON.stringify(original.url)};\n` +
          `import { resolveSecureTempRoot as original } from ${JSON.stringify(original.url)};\n` +
          `import { resolveManagedHandoffTestTempRoot } from ${JSON.stringify(helperUrl)};\n` +
          `export function resolveSecureTempRoot(options) { return resolveManagedHandoffTestTempRoot(` +
          `${JSON.stringify(binding)}, original, options, ${JSON.stringify({ id, phase, consumer })}); }\n`,
      );
      return { url: pathToFileURL(shim).href, shortCircuit: true };
    },
  });
  // Refuse the invocation before its entrypoint if the actual dependency cannot
  // honor this binding. Consumer copies are separately resolved by the hook above.
  const temp = createRequire(import.meta.url)(
    "@openclaw/fs-safe/temp",
  ) as typeof import("@openclaw/fs-safe/temp");
  assert.equal(
    temp.resolveSecureTempRoot({
      preferredDir: "/tmp/openclaw",
      fallbackPrefix: "openclaw",
      skipPreferredOnWindows: true,
    }),
    binding.directory,
  );
}

export function resolveManagedHandoffTestTempRoot(
  binding: Binding,
  original: SecureTempResolver,
  options: Parameters<SecureTempResolver>[0],
  witness: { id: string; phase: string; consumer: string },
) {
  // Explicit application caches keep their selected path. Only the default OpenClaw
  // scratch resolver is rebound; the normal product default and resolver stay unchanged.
  if (
    options.preferredDir === undefined
      ? options.fallbackPrefix !== "openclaw"
      : !sharedRoots.has(options.preferredDir)
  ) {
    return original(options);
  }
  const databasePath = assertManagedHandoffTestPath(binding);
  const resolved = original({
    ...options,
    preferredDir: binding.directory,
    tmpdir: () => binding.directory,
    skipPreferredOnWindows: false,
  });
  assert.equal(resolved, binding.directory, "Handoff resolver escaped its explicit binding");
  assertManagedHandoffTestPath(binding);
  writeExactPrivateModule(
    path.join(binding.directory, `preflight-${process.pid}-${threadId}-${witness.id}.json`),
    JSON.stringify({
      pid: process.pid,
      threadId,
      databasePath,
      realParent: fs.realpathSync(resolved),
      phase: witness.phase,
      consumer: witness.consumer,
    }) + "\n",
  );
  return resolved;
}

/** Setup-only resolver calls cannot prove the target consumer honored the binding. */
export function assertManagedHandoffTestConsumer(
  binding: Binding,
  pid: number | undefined,
  consumerRoot: string,
) {
  assertManagedHandoffTestPath(binding);
  assert(pid !== undefined, "Handoff consumer has no process identity");
  const prefix = pathToFileURL(path.resolve(consumerRoot) + path.sep).href;
  const witnesses = fs
    .readdirSync(binding.directory)
    .filter((name) => name.startsWith(`preflight-${pid}-0-`))
    .map((name) => JSON.parse(fs.readFileSync(path.join(binding.directory, name), "utf8")));
  assert(
    witnesses.some(
      (entry) =>
        entry.pid === pid &&
        entry.threadId === 0 &&
        entry.phase === "consumer" &&
        typeof entry.consumer === "string" &&
        entry.consumer.startsWith(prefix) &&
        entry.databasePath === binding.databasePath &&
        entry.realParent === binding.directory,
    ),
    "No bound handoff resolver witness from the target consumer",
  );
}
