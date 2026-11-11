import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

/** A missing alias is a fixture failure, never permission to use the canonical root. */
export async function resolveRetainedRuntimeTestRoot(
  root: string,
  runtime: "node" | "bun" | "node-short-path" | "node-junction",
): Promise<string> {
  if (runtime === "node-junction") {
    const alias = path.join(path.dirname(root), "install-alias");
    await fs.symlink(root, alias, "junction");
    return alias;
  }
  if (runtime !== "node-short-path") {
    return root;
  }
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", 'for %I in ("' + root + '") do @echo %~sI'],
    // cmd.exe owns this command string; do not apply CRT argument quoting.
    { encoding: "utf8", windowsVerbatimArguments: true },
  );
  if (process.env.OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS === "1") {
    console.error(JSON.stringify({ phase: "short-path", requested: root, returned: result.stdout }));
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const alias = result.stdout.trim();
  assert(!/["\r\n]/u.test(alias), "malformed 8.3 alias output");
  assert(path.isAbsolute(alias), "8.3 alias must be an absolute path");
  assert.notEqual(alias, root, "8.3 alias unavailable on the fixture volume");
  assert.equal(await fs.realpath(alias), await fs.realpath(root));
  return alias;
}
