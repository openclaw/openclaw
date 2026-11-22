import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, sep } from "node:path";
import { shellEscape } from "../../src/shared/shell-quote.js";
import { resolveTestTempRoot } from "../../src/test-utils/env.js";

export function resolveGitOutsideFixtures(env: NodeJS.ProcessEnv = process.env): string {
  const git = realpathSync(
    execFileSync("/bin/sh", ["-c", "command -v git"], { env, encoding: "utf8" }).trim(),
  );
  const tempRoot = realpathSync(resolveTestTempRoot());
  // Vitest allocates sibling oc-vt-* roots; reject prior workers too.
  const fixtures = basename(tempRoot).startsWith("oc-vt-") ? dirname(tempRoot) : tempRoot;
  if (git === fixtures || git.startsWith(`${fixtures}${sep}`)) {
    throw new Error(`Refusing fixture Git as a shim backend: ${git}`);
  }
  return git;
}

export const gitPathShimGuard = `if [ -n "\${OPENCLAW_TEST_GIT_SHIM_ACTIVE:-}" ]; then
  echo "recursive test Git shim invocation refused" >&2
  exit 98
fi
export OPENCLAW_TEST_GIT_SHIM_ACTIVE=1`;

export function gitPathShimShellPrelude(env: NodeJS.ProcessEnv = process.env): string {
  return `${gitPathShimGuard}\nexport PATH=${shellEscape(env.PATH ?? "")}`;
}

export function gitPathShimJavaScriptPrelude(env: NodeJS.ProcessEnv = process.env): string {
  return `if (process.env.OPENCLAW_TEST_GIT_SHIM_ACTIVE) {
  console.error("recursive test Git shim invocation refused");
  process.exit(98);
}
process.env.OPENCLAW_TEST_GIT_SHIM_ACTIVE = "1";
process.env.PATH = ${JSON.stringify(env.PATH ?? "")};`;
}
