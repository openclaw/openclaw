import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { parse } from "yaml";
import { createCommandTest } from "../helpers/command-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPnpmArchiveFixture } from "./setup-pnpm-archive.test-support.js";

const it = createCommandTest();
const read = (file: string) => fs.readFileSync(file, "utf8");
const workflow = parse(read(".github/workflows/crabbox-hydrate.yml"));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function expectNoSeed(
  result: { status: number | null; stderr: string; stdout: string },
  runner: string,
) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(fs.readdirSync(runner)).toEqual([]);
}

describe("pnpm image archive consumer", () => {
  it.for([
    { platform: "win32", version: "12.15.0" },
    { platform: "linux", version: "12.15.0" },
  ] as const)(
    "seeds $platform jobs from verified $version archives into private Corepack state",
    async ({ platform, version }, { command }) => {
      const f = createPnpmArchiveFixture(command, { platform, image: true });
      const homes: string[] = [];
      for (let run = 0; run < 2; run++) {
        const result = await f.run();
        expect(result.status, result.stderr).toBe(0);
        const home = result.stdout.trim();
        expect(home).not.toBe("");
        homes.push(home);
        const pnpmRoot = join(home, "v1", "pnpm", version);
        expect(read(join(pnpmRoot, "pnpm"))).toBe(`pnpm-${version}.tgz`);
        if (platform === "linux") {
          expect(read(join(pnpmRoot, "node_modules/@pnpm/exe.linux-x64/pnpm"))).toBe(
            `exe.linux-x64-${version}.tgz`,
          );
        } else {
          expect(fs.existsSync(join(pnpmRoot, "node_modules"))).toBe(false);
        }
        const metadata = JSON.parse(read(join(pnpmRoot, ".corepack")));
        expect(metadata).toMatchObject({
          hash: f.spec.slice(f.spec.indexOf("+") + 1),
          bin: { pnpm: "./bin/pnpm.mjs" },
        });
        expect(
          execFileSync(process.execPath, [join(pnpmRoot, metadata.bin.pnpm)], {
            encoding: "utf8",
          }).trim(),
        ).toBe(version);
        fs.writeFileSync(join(pnpmRoot, "pnpm"), "tampered extracted executable");
      }
      expect(homes[0]).not.toBe(homes[1]);
      expect(fs.existsSync(join(f.root, "old-corepack"))).toBe(false);
      expect(fs.readdirSync(f.runner)).toHaveLength(2);
    },
  );

  it.for([
    { platform: "win32", version: "12.15.0", name: "pnpm-12.15.0.tgz" },
    { platform: "linux", version: "12.15.0", name: "pnpm-12.15.0.tgz" },
    { platform: "linux", version: "12.15.0", name: "exe.linux-x64-12.15.0.tgz" },
  ] as const)(
    "delegates substituted $name on $platform to Corepack, ignoring adjacent trust markers",
    async ({ platform, name }, { command }) => {
      const f = createPnpmArchiveFixture(command, { platform, image: true });
      fs.writeFileSync(join(f.image, name), "bad archive");
      fs.writeFileSync(join(f.image, ".complete"), "");
      fs.writeFileSync(
        join(f.image, `${name}.sha512`),
        createHash("sha512").update("bad archive").digest("hex"),
      );
      expectNoSeed(await f.run(), f.runner);
    },
  );

  it.for(["different-version", "different-hash"])(
    "leaves Corepack preparation in control for %s despite valid cached archives",
    async (kind, { command }) => {
      const f = createPnpmArchiveFixture(command, { image: true });
      const requested =
        kind === "different-version"
          ? f.spec.replace("12.15.0", "12.3.4")
          : f.spec.replace(/.$/u, "z");
      expectNoSeed(await f.run({}, requested), f.runner);
    },
  );

  it("wires image seeding before preparation without changing dependency installation", () => {
    const action = parse(read(".github/actions/setup-pnpm-store-cache/action.yml"));
    for (const steps of [action.runs.steps, workflow.jobs.hydrate.steps]) {
      const preparation = steps.find((step: { run?: string }) =>
        step.run?.includes("corepack prepare"),
      );
      expect(preparation.run.indexOf("seed-pnpm-from-image.mjs")).toBeLessThan(
        preparation.run.indexOf("corepack prepare"),
      );
      expect(preparation.run).toContain('echo "COREPACK_HOME=$COREPACK_HOME" >> "$GITHUB_ENV"');
    }
    expect(
      workflow.jobs.hydrate.steps.find((step: { run?: string }) =>
        step.run?.includes("install_args="),
      ).run,
    ).toContain("--frozen-lockfile");
  });

  it.each([
    ["hydrate", true],
    ["hydrate", false],
    ["hydrate-github", true],
    ["hydrate-github", false],
  ] as const)("restores %s Corepack state in a fresh shell (configured=%s)", (job, configured) => {
    const ready = workflow.jobs[job].steps.find(
      (step: { name?: string }) => step.name === "Mark Crabbox ready",
    );
    const home = tempDirs.make("crabbox-session-");
    const corepackHome = join(
      home,
      "corepack cache ' \" $HOME $(touch injected) `touch injected` ;",
    );
    fs.mkdirSync(corepackHome);
    fs.writeFileSync(join(corepackHome, "ready.txt"), "prepared cache fixture\n");
    const env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      CRABBOX_ID: "image-cache",
      CRABBOX_JOB: job,
      GITHUB_WORKSPACE: home,
      GITHUB_RUN_ID: "123",
    };
    const shell = (script: string, extraEnv = {}, args: string[] = []) =>
      spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script, ...args], {
        cwd: home,
        encoding: "utf8",
        env: { ...env, ...extraEnv },
      });
    const marked = shell(
      `docker() { :; }\n${ready.run}`,
      configured ? { COREPACK_HOME: corepackHome } : {},
    );
    expect(marked.status, marked.stderr).toBe(0);
    const restored = shell(
      `set -euo pipefail
source "$1"
if [ "\${COREPACK_HOME+x}" = x ]; then
  printf '%s\\n' "$COREPACK_HOME"
  cat "$COREPACK_HOME/ready.txt"
else
  printf 'unset\\n'
fi`,
      {},
      ["saved-session", join(home, ".crabbox", "actions", "image-cache.env.sh")],
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toBe(
      configured ? `${corepackHome}\nprepared cache fixture\n` : "unset\n",
    );
    expect(fs.existsSync(join(home, "injected"))).toBe(false);
  });
});
