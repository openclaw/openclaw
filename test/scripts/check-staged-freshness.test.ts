import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectStagedFreshnessChecks } from "../../scripts/pre-commit/check-staged-freshness.mts";
import { createScriptTestHarness } from "./test-helpers.js";
import { createToolingDependencyFixture } from "./tooling-dependencies.test-support.mts";

const { createTempDir } = createScriptTestHarness();

const scripts = (paths: string[]) => selectStagedFreshnessChecks(paths).map(({ script }) => script);

describe("selectStagedFreshnessChecks", () => {
  it("qualifies native i18n tooling without using the package-script loader or linking it", () => {
    const root = createTempDir("openclaw-hook-native-i18n-");
    const fixture = createToolingDependencyFixture(root);
    mkdirSync(path.join(fixture.checkout, "apps/android/gradle"), { recursive: true });
    writeFileSync(
      path.join(fixture.checkout, "apps/android/gradle/libs.versions.toml"),
      "[versions]\n",
    );
    writeFileSync(
      path.join(fixture.checkout, "scripts/native-app-i18n.ts"),
      `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import value from "fixture-pkg";
assert.equal(value, "qualified");
assert.equal(process.env.TOOLING_FIXTURE_PRELOADED, "1");
assert.equal(process.env.TSX_DISABLE_CACHE, "1");
assert.equal(process.versions.bun, undefined);
writeFileSync("native-args", JSON.stringify(process.argv.slice(2)));
`,
    );
    const manifest = path.join(fixture.checkout, "package.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        ...JSON.parse(readFileSync(manifest, "utf8")),
        scripts: { "native:i18n:verify": "node missing-legacy-loader.mjs" },
      }),
    );
    execFileSync("git", ["add", "apps/android/gradle/libs.versions.toml"], {
      cwd: fixture.checkout,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      OPENCLAW_PR_TOOLING_ROOT: fixture.tooling,
    };
    for (const key of [
      "PNPM_CONFIG_MODULES_DIR",
      "pnpm_config_modules_dir",
      "npm_config_modules_dir",
      "OPENCLAW_PR_GIT",
    ]) {
      delete env[key];
    }
    const script = path.resolve(
      import.meta.dirname,
      "../../scripts/pre-commit/check-staged-freshness.mts",
    );
    const run = () =>
      spawnSync(process.execPath, [script], {
        cwd: fixture.checkout,
        env,
        encoding: "utf8",
      });
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(fixture.checkout, "native-args"), "utf8"))).toEqual([
      "verify",
    ]);
    expect(existsSync(path.join(fixture.checkout, "node_modules"))).toBe(false);

    fixture.writePackage(
      "fixture-pkg",
      'throw new Error("STALE PACKAGE EXECUTED");',
      "0.0.0-stale",
    );
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("requires 1.0.0");
    expect(rejected.stderr).toContain("native app i18n inventory failed");
    expect(rejected.stderr).toContain(
      "pnpm native:i18n:baseline from an independently installed checkout of this branch",
    );
    expect(rejected.stdout + rejected.stderr).not.toContain("STALE PACKAGE EXECUTED");
    expect(existsSync(path.join(fixture.checkout, "node_modules"))).toBe(false);
  });

  it("executes package-script checks with the pinned pnpm CLI", () => {
    const root = createTempDir("openclaw-hook-pnpm-");
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs/proof.md"), "# Proof\n");
    writeFileSync(
      path.join(root, "lint-fixture.cjs"),
      "require('node:fs').writeFileSync('lint-ran', 'ok')",
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "lint:docs": 'node "lint-fixture.cjs"',
        },
      }),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "docs/proof.md"], { cwd: root });
    const script = path.resolve(
      import.meta.dirname,
      "../../scripts/pre-commit/check-staged-freshness.mts",
    );
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "lint-ran"), "utf8")).toBe("ok");
  });

  it.each([
    [["docs/install/docker.md"], "lint:docs"],
    [["packages/gateway-protocol/src/schema/logs-chat.ts"], "protocol:check"],
    [
      ["apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt"],
      "native:i18n:verify",
    ],
    [["extensions/x/openclaw.plugin.json"], "config:docs:check"],
    [["extensions/feishu/src/bot.test.ts"], "check:line-cap-ratchet"],
    [["src/gateway/AGENTS.md"], "check:agents-md-size"],
  ])("selects the CI-owned check for %j", (paths, script) => {
    expect(scripts(paths)).toContain(script);
  });

  it("adds no work for paths no freshness check owns", () => {
    expect(scripts(["CHANGELOG.md", "docs/missing-page.md", ".github/CODEOWNERS"])).toEqual([]);
  });
});
