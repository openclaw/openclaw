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

const scenarios = [
  {
    name: "a joined build failure",
    args: ["qaRuntime"],
    exitCode: 7,
    diagnostic: "[build-all] plugins:assets:build failed",
    runsWorkload: true,
  },
  {
    name: "argument rejection",
    args: ["--bogus"],
    exitCode: 2,
    diagnostic: "unknown argument: --bogus",
    runsWorkload: false,
  },
];

for (const scenario of scenarios) {
  it(`releases inherited artifact ownership after ${scenario.name}`, async ({ signal }) => {
    await fixture.run(async () => {
      const root = fs.realpathSync(fixture.createTempDir("openclaw-build-all-ownership-"));
      fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}\n');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
      const settled = path.join(root, "workload-settled.json");
      const pnpm = path.join(root, "pnpm.cjs");
      // Only the terminal workload is synthetic; build selection, child joining,
      // inherited claims and their cleanup all run through the real entrypoints.
      fs.writeFileSync(
        pnpm,
        `require("node:fs").writeFileSync(${JSON.stringify(settled)}, JSON.stringify(process.argv.slice(2)));
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
  args: ${JSON.stringify(distArtifactEntryArgs(path.join(sourceRoot, "scripts/build-all.mts"), scenario.args))},
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
          npm_execpath: pnpm,
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
      expect(result, output).toBe(scenario.exitCode);
      expect(output).toContain(scenario.diagnostic);
      expect(fs.existsSync(settled), output).toBe(scenario.runsWorkload);
      if (scenario.runsWorkload) {
        expect(JSON.parse(fs.readFileSync(settled, "utf8"))).toEqual([
          "plugins:assets:build",
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
    });
  });
}
