import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32")(
  "preserves the transform generation through the setup action",
  () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step = action.runs.steps.find(
      (candidate: { name: string }) =>
        candidate.name === "Resolve Vitest transform cache generation",
    );
    const included = [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "packages/example/package.json",
      "packages/example/tsconfig.json",
      "vitest.config.ts",
      "ui/vitest.config.ts",
      "ui/vitest.node.config.ts",
      "scripts/control-ui-parity/vitest.config.ts",
      "scripts/control-ui-retention/vitest.config.ts",
      "test/vitest/vitest.shared.config.ts",
      "test/vitest/vitest.worker-artifacts.ts",
      "test/vitest/vitest.performance-config.ts",
      "test/vitest/vitest.ui-e2e-prebuilt.config.ts",
      "test/vitest/nested/vitest.ui-e2e.config.ts",
      "test/vitest/vitest.ui-e2e.setup.ts",
      "test/vitest/vitest.ui-e2e.bundled.global-setup.ts",
      "test/vitest/vitest.channel-paths.mjs",
      "test/vitest/nested/vitest.database-worker-core-paths.mjs",
      "test/vitest/nested/vitest.unit-fast-paths.mjs",
      "src/state/schema.sql",
      ".hidden/tsconfig.json",
      ".git/custom/package.json",
      ".ci-harness-source/package.json",
      "nested/.ci-harness/package.json",
      "nested/package.json/descendant",
      "tsconfig.directory.json/descendant",
      "src/state/directory.sql/descendant",
    ];
    const excluded = [
      "test/vitest/vitest.database-worker-core-paths.mjs",
      "test/vitest/vitest.extension-database-workers-paths.mjs",
      "test/vitest/vitest.ui-e2e.config.ts",
      "test/vitest/vitest.unit-fast-paths.mjs",
      "node_modules/example/package.json",
      ".ci-harness/package.json",
      ".ci-harness/tsconfig.json",
      "nested/node_modules/example/tsconfig.json",
      "src/state/nested/other.sql",
      "docs/example.md",
    ];
    const root = tempDirs.make("openclaw-transform-generation-");
    const output = path.join(root, "output");
    const fingerprint = () => {
      const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTION_PATH: path.resolve(".github/actions/setup-node-env"),
          GITHUB_OUTPUT: output,
        },
      });
      if (result.status === 0) {
        return readFileSync(output, "utf8").trim().split("\n").at(-1)!.slice("value=".length);
      }
      throw new Error(result.stderr);
    };
    expect(fingerprint()).toBe("");
    for (const file of [...included, ...excluded]) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify({ file })}\n`);
    }
    const expected = () => {
      const hash = createHash("sha256");
      for (const file of included.toSorted()) {
        hash.update(
          createHash("sha256")
            .update(readFileSync(path.join(root, file)))
            .digest(),
        );
      }
      return hash.digest("hex");
    };
    const generation = expected();
    expect(fingerprint()).toBe(generation);
    writeFileSync(path.join(root, ".ci-harness/package.json"), '{"changed":true}');
    expect(fingerprint()).toBe(generation);
    writeFileSync(path.join(root, "src/state/schema.sql"), "CREATE TABLE fixture (id TEXT);");
    expect(fingerprint()).toBe(expected());
    symlinkSync("src/state/schema.sql", path.join(root, "tsconfig.alias.json"));
    included.push("tsconfig.alias.json");
    symlinkSync("packages", path.join(root, "tsconfig.link.json"));
    expect(fingerprint()).toBe(expected());
    symlinkSync("missing", path.join(root, "tsconfig.broken.json"));
    expect(fingerprint).toThrow();
  },
);

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
