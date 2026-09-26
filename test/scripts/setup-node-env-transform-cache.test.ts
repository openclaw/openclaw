import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "reports archive restoration separately from local generation retention",
  () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step = action.runs.steps.find(
      (candidate: { name: string }) => candidate.name === "Configure Vitest transform cache",
    );
    expect(step.env.CACHE_RESTORED).toBe(
      "${{ steps.vitest-cache.outputs['cache-matched-key'] != '' && 'true' || 'false' }}",
    );
    const generation = "a".repeat(64);
    for (const scenario of [
      { restored: "true", marker: generation, entry: true, local: "retained" },
      { restored: "false", marker: generation, entry: true, local: "retained" },
      { restored: "true", marker: "b".repeat(64), entry: true, local: "cleared" },
      { restored: "true", marker: undefined, entry: true, local: "cleared" },
      { restored: "false", marker: undefined, entry: false, local: "empty" },
    ]) {
      const root = tempDirs.make("openclaw-transform-cache-");
      const cache = path.join(root, "cache");
      const githubEnv = path.join(root, "env");
      const marker = path.join(cache, ".openclaw-transform-generation");
      const entry = path.join(cache, "entry");
      mkdirSync(cache);
      if (scenario.marker !== undefined) {
        writeFileSync(marker, scenario.marker);
      }
      if (scenario.entry) {
        writeFileSync(entry, "cached transform");
      }
      // Only relocate the fixed cache root; execute the shipped action body.
      const script = step.run.replace(
        "cache_root=/var/tmp/openclaw-vitest-fs-cache",
        'cache_root="$TEST_CACHE_ROOT"',
      );
      const result = spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          TEST_CACHE_ROOT: cache,
          GITHUB_ENV: githubEnv,
          CACHE_GENERATION: generation,
          CACHE_WRITER: step.env.CACHE_WRITER,
          CACHE_RESTORED: scenario.restored,
          CACHE_RUNNER_ENVIRONMENT: "github-hosted",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `Vitest transform cache: restored=${scenario.restored} local=${scenario.local} generation=${generation} runner=github-hosted`,
      );
      expect(readFileSync(marker, "utf8")).toBe(`${generation}\n`);
      expect(existsSync(entry)).toBe(scenario.local === "retained");
      if (scenario.local === "retained") {
        expect(readFileSync(entry, "utf8")).toBe("cached transform");
      }
      expect(readFileSync(githubEnv, "utf8")).toBe(
        `OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT=${cache}\nOPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=0\n`,
      );
    }
  },
);
