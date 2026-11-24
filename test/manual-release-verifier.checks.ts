import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const actionRoot = ".github/actions/setup-release-verifier";

it("locks the verifier's only runtime dependency to the reviewed workspace version and integrity", () => {
  const manifest = JSON.parse(readFileSync(`${actionRoot}/package.json`, "utf8"));
  const lock = JSON.parse(readFileSync(`${actionRoot}/package-lock.json`, "utf8"));
  const workspace = JSON.parse(readFileSync("package.json", "utf8"));
  const workspaceLock = parse(
    pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8")).dependencies,
  );
  expect(manifest.dependencies).toEqual({ zod: workspace.dependencies.zod });
  expect(Object.keys(lock.packages)).toEqual(["", "node_modules/zod"]);
  expect(lock.packages["node_modules/zod"].integrity).toBe(
    workspaceLock.packages[`zod@${workspace.dependencies.zod}`].resolution.integrity,
  );
});

// This manual-only boundary check uses real npm and may access the registry.
it.each([".", "trusted-workflow", ".closeout-tooling"])(
  "executes the verifier with only isolated dependencies in %s",
  (toolingRoot) => {
    const root = roots.make("release-verifier-runtime-");
    const tooling = join(root, toolingRoot);
    const temp = join(root, "runner-temp");
    mkdirSync(temp, { recursive: true });
    cpSync("scripts", join(tooling, "scripts"), {
      recursive: true,
      filter: (path) => !path.split(sep).includes("node_modules"),
    });
    writeFileSync(
      join(tooling, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "must-not-install-workspace": "file:./missing-package" },
        scripts: { preinstall: "exit 99" },
      }),
    );
    const action = parse(readFileSync(`${actionRoot}/action.yml`, "utf8"));
    const result = spawnSync("bash", ["-c", action.runs.steps[0].run], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RUNNER_TEMP: temp,
        GITHUB_ACTION_PATH: resolve(actionRoot),
        GITHUB_WORKSPACE: root,
        TOOLING_ROOT: toolingRoot,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(tooling, "node_modules"))).toBe(false);
    const modules = join(tooling, "scripts/lib/node_modules");
    expect(readdirSync(modules)).toEqual(["zod"]);
    const installed = realpathSync(join(modules, "zod"));
    expect(readdirSync(resolve(installed, "..")).toSorted()).toEqual([".package-lock.json", "zod"]);
    const verifier = pathToFileURL(join(tooling, "scripts/lib/release-fast-track-publication.mts"));
    const execution = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const { parseFastTrackApproval, releaseFastTrackDigest } = await import(${JSON.stringify(verifier.href)});
      assert.match(releaseFastTrackDigest({ synthetic: true }), /^sha256:[a-f0-9]{64}$/);
      assert.throws(() => parseFastTrackApproval({}), error => error.name === 'ZodError');
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(execution.status, execution.stderr).toBe(0);
  },
  45_000,
);
