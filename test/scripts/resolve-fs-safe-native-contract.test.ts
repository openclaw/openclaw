import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/resolve-fs-safe-native-contract.mjs");
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function commitSource(fsSafeVersion: string, native: boolean, remoteBranch?: string) {
  const root = tempDirectories.make("openclaw-fs-safe-contract-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@openclaw.local");
  git("config", "user.name", "OpenClaw test");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: "2026.8.33", dependencies: { "@openclaw/fs-safe": fsSafeVersion } })}\n`,
  );
  const defaultsPath = join(root, "src/infra/fs-safe-defaults.ts");
  mkdirSync(dirname(defaultsPath), { recursive: true });
  writeFileSync(
    defaultsPath,
    `import { configureFsSafe${native ? "Native" : "Python"} } from "@openclaw/fs-safe/config";\n`,
  );
  git("add", ".");
  git("commit", "-qm", "fixture");
  if (remoteBranch) {
    git("update-ref", `refs/remotes/origin/${remoteBranch}`, "HEAD");
  }
  return { root, ref: git("rev-parse", "HEAD") };
}

function resolveContract(root: string, ref: string, allow = true, workflow = "f".repeat(40)) {
  return execFileSync(process.execPath, [SCRIPT, ref, workflow, allow ? "1" : "0"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  }).trim();
}

it.each([
  ["0.5.6", true, "extended-stable/2026.8.33", "bundled"],
  ["0.3.0", false, undefined, "required"],
  ["0.3.0", false, "release/2026.9.1", "required"],
  ["0.4.1", false, "extended-stable/2026.8.33", "required"],
] as const)("fs-safe %s native=%s branch=%s: %s", (version, native, branch, expected) => {
  const { root, ref } = commitSource(version, native, branch);
  expect(resolveContract(root, ref)).toBe(expected);
  if (expected === "bundled") {
    expect(resolveContract(root, ref, false)).toBe("required");
    expect(resolveContract(root, ref, true, ref)).toBe("required");
  }
});

it("uses only sparse-materialized fs-safe ownership sources for the supported frozen target", () => {
  const { root, ref } = commitSource("0.5.6", true);
  writeFileSync(
    join(root, "git"),
    `#!/usr/bin/env sh
case "$1" in
  for-each-ref) printf '%s\\n' 'origin/extended-stable/2026.8.33' ;;
  show)
    case "$2" in
      ${ref}:package.json|${ref}:src/infra/fs-safe-defaults.ts) cat "\${2#*:}" ;;
      *) echo "unmaterialized source: $2" >&2; exit 128 ;;
    esac ;;
  *) echo "unexpected git operation: $1" >&2; exit 128 ;;
esac
`,
    { mode: 0o755 },
  );
  expect(resolveContract(root, ref)).toBe("bundled");
});
