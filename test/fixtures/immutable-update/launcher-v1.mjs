#!/usr/bin/env node
// Adoption pins the external Node path in this shebang; this launcher never updates current.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const launcher = fileURLToPath(import.meta.url);
  const root = path.dirname(path.dirname(launcher));
  const releases = path.join(root, "releases");
  const pointer = path.join(root, "current");
  const generation = fs.realpathSync(pointer);
  if (path.dirname(generation) !== releases || !/^[a-f0-9]{40}$/u.test(path.basename(generation))) {
    throw new Error("current must select a direct releases/<full-sha> generation");
  }
  for (const directory of [root, path.dirname(launcher), releases, generation]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`unsafe immutable installation directory: ${directory}`);
    }
  }
  const current = fs.lstatSync(pointer);
  if (!current.isSymbolicLink() || current.uid !== 0) {
    throw new Error("current must be an updater-owned symlink");
  }
  const entry = path.join(generation, "dist", "index.js");
  const stat = fs.lstatSync(entry);
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    (stat.mode & 0o222) !== 0 ||
    fs.realpathSync(entry) !== entry
  ) {
    throw new Error("the Gateway entrypoint must be a sealed regular file");
  }
  if (typeof process.execve !== "function") {
    throw new Error("the pinned Node executable does not support execve");
  }
  // Both cwd and argv use the selected physical tree, including subsequent lazy imports.
  process.chdir(generation);
  process.execve(
    process.execPath,
    [process.execPath, entry, "gateway", ...process.argv.slice(2)],
    process.env,
  );
} catch (error) {
  console.error(
    `Cannot start immutable OpenClaw Gateway: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 78;
}
