import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  distArtifactEntryArgs,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-ownership.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

const fixture = createFixtureLifetime();
const sourceRoot = process.cwd();
const node = resolveTestNodeExecPath();
const sourceUrl = (relative: string) => pathToFileURL(path.join(sourceRoot, relative)).href;
afterEach(() => fixture.cleanup());

it.for([
  ["qaRuntime", 7, "[build-all] plugins:assets:build failed", true],
  ["--bogus", 2, "unknown argument: --bogus", false],
] as const)(
  "releases inherited artifact ownership after %s",
  ([arg, exitCode, diagnostic, runsWorkload], { signal }) =>
    fixture.run(async () => {
      const root = fs.realpathSync(fixture.createTempDir("openclaw-build-all-ownership-"));
      const at = (file: string) => path.join(root, file);
      fs.writeFileSync(at("package.json"), '{"private":true,"type":"module"}\n');
      fs.writeFileSync(at("pnpm-workspace.yaml"), "packages: []\n");
      const settled = at("workload-settled.json");
      fs.mkdirSync(at("scripts"));
      fs.writeFileSync(at("scripts/tsx.mjs"), "");
      // Only the terminal workload/loader are synthetic; build selection, child joining,
      // inherited claims and their cleanup all run through the real entrypoints.
      fs.writeFileSync(
        at("scripts/bundled-plugin-assets.mts"),
        `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(settled)}, JSON.stringify(process.argv.slice(2)));
console.error("fixture joined build failure");
process.exitCode = 7;
`,
      );
      let output = "";
      const result = await runManagedCommand({
        bin: node,
        args: [
          "--import",
          sourceUrl("scripts/tsx.mjs"),
          "--input-type=module",
          "-e",
          `
import { withDistArtifactOwnership } from ${JSON.stringify(sourceUrl("scripts/lib/dist-artifact-ownership.mts"))};
import { runManagedCommand } from ${JSON.stringify(sourceUrl("scripts/lib/managed-child-process.mts"))};
process.exitCode = await withDistArtifactOwnership(process.cwd(), () => runManagedCommand({
  bin: process.execPath,
  args: ${JSON.stringify(distArtifactEntryArgs(path.join(sourceRoot, "scripts/build-all.mts"), [arg]))},
  shell: false,
  stdio: "inherit",
  requireProcessTreeExit: process.platform !== "win32",
}));
`,
        ],
        cwd: root,
        env: {
          ...process.env,
          GIT_COMMIT: "a".repeat(40),
          OPENCLAW_BUILD_ALL_NO_PNPM: "0",
          OPENCLAW_BUILD_CACHE: "0",
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          npm_execpath: at("unavailable-pnpm.cjs"),
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        requireProcessTreeExit: process.platform !== "win32",
        signal,
        onReady(child) {
          for (const pipe of [child.stdout, child.stderr]) {
            pipe?.on("data", (chunk) => (output += String(chunk)));
          }
        },
      });
      expect(result, output).toBe(exitCode);
      expect(output).toContain(diagnostic);
      expect(fs.existsSync(settled), output).toBe(runsWorkload);
      if (runsWorkload) {
        expect(JSON.parse(fs.readFileSync(settled, "utf8"))).toEqual([
          "--phase",
          "build",
          "--defer-isolated",
        ]);
        expect(output).toContain("fixture joined build failure");
      }
      const lock = resolveDistArtifactLockPath(root);
      expect(fs.readdirSync(lock), output).toEqual([]);
      await withDistArtifactOwnership(root, async () => {
        expect(fs.existsSync(path.join(lock, "owner.json"))).toBe(true);
      });
      expect(fs.readdirSync(lock)).toEqual([]);
    }),
);
