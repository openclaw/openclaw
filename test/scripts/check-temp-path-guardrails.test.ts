import { spawnSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("reports unsafe runtime paths without mistaking quoted delimiters or test fixtures for paths", () => {
  const root = tempDirs.make("openclaw-temp-path-guard-");
  const sources = {
    "src/dynamic.ts": "path.join(os.tmpdir(), `run-${id}`);",
    "src/nested.ts": 'path.join(os.tmpdir(), choose(")", { close: ["]"] }), `run-${id}`);',
    "src/escaped.ts": 'path.join(os.tmpdir(), choose("escaped \\" quote, )"), `run-${id}`);',
    "extensions/probe/random.ts": "const id = Date.now() + Math.random();",
    "src/safe.ts": [
      'path.join(os.tmpdir(), "literal ${id}, (");',
      'path.join(other(")"), `run-${id}`);',
      'path.join(os.tmpdir(), `fixed`, nested({ value: ["closing )"] }));',
      "// path.join(os.tmpdir(), `comment-${id}`);",
    ].join("\n"),
    "src/fixture.test.ts": "path.join(os.tmpdir(), `test-${id}`);",
  };
  for (const [file, source] of Object.entries(sources)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const runGuard = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repoRoot, "scripts/tsx.mjs"),
        path.join(repoRoot, "scripts/check-temp-path-guardrails.ts"),
      ],
      { cwd: root, encoding: "utf8" },
    );

  const rejected = runGuard();
  expect(rejected.error).toBeUndefined();
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toBe("");
  expect(rejected.stderr.replaceAll("\\", "/")).toBe(
    "Dynamic os.tmpdir()/path.join() template paths found:\n" +
      "- src/dynamic.ts\n- src/escaped.ts\n- src/nested.ts\n" +
      "Weak Date.now()+Math.random() same-line IDs found:\n- extensions/probe/random.ts\n",
  );

  for (const file of [
    "src/dynamic.ts",
    "src/escaped.ts",
    "src/nested.ts",
    "extensions/probe/random.ts",
  ]) {
    unlinkSync(path.join(root, file));
  }
  const accepted = runGuard();
  expect(accepted.error).toBeUndefined();
  expect(accepted.status).toBe(0);
  expect(accepted.stdout).toBe("");
  expect(accepted.stderr).toBe("");
});
