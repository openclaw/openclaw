import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { selectStagedFreshnessChecks } from "../../scripts/pre-commit/check-staged-freshness.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const scripts = (paths: string[]) => selectStagedFreshnessChecks(paths).map(({ script }) => script);

describe("selectStagedFreshnessChecks", () => {
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
