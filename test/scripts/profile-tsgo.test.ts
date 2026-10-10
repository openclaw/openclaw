import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("rejects inherited graph names before creating artifacts or starting a compiler", () => {
  const root = tempDirs.make("openclaw-profile-tsgo-");
  const outDir = path.join(root, "profile");
  const compilerStarted = path.join(root, "compiler-started");
  const preload = path.join(root, "block-compiler.mjs");
  // A broken admission path must not launch an expensive compiler in this regression.
  writeFileSync(
    preload,
    `import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = () => {
  writeFileSync(${JSON.stringify(compilerStarted)}, "attempted");
  throw new Error("Compiler launch blocked by fixture");
};
syncBuiltinESMExports();
`,
  );

  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      preload,
      "scripts/profile-tsgo.mts",
      "constructor",
      `--out=${outDir}`,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
  );

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Unknown graph: constructor\n\nUsage: pnpm tsgo:profile/u);
  expect(existsSync(outDir)).toBe(false);
  expect(existsSync(compilerStarted)).toBe(false);
});
