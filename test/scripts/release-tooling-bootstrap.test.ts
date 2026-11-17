import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("installs with the tooling cwd while retaining the release source root", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
  const install = workflow.jobs.publish.steps.find(
    (step: { name: string }) => step.name === "Install trusted release tooling dependencies",
  );
  const source = createTempDir("release-tooling-bootstrap-");
  const tooling = join(source, ".release-harness");
  const bin = join(source, "bin");
  const receipt = join(source, "install-cwd");
  mkdirSync(tooling);
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\npwd > "$INSTALL_CWD"\nmkdir -p node_modules\n', {
    mode: 0o755,
  });
  // Match Actions shell startup: host rc files must not replace fixture commands.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${install.run}\npwd`], {
    cwd: source,
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, INSTALL_CWD: receipt },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(realpathSync(readFileSync(receipt, "utf8").trim())).toBe(realpathSync(tooling));
  expect(realpathSync(result.stdout.trim())).toBe(realpathSync(source));
  expect(realpathSync(join(source, "node_modules"))).toBe(
    realpathSync(join(tooling, "node_modules")),
  );
});

it("executes installed qualification completeness outside the development dependency tree", () => {
  const tooling = createTempDir("release-completeness-bootstrap-");
  // Never link scripts back to the development tree: native resolution stays isolated.
  cpSync("scripts", join(tooling, "scripts"), { recursive: true });
  cpSync("packages/normalization-core", join(tooling, "packages/normalization-core"), {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.includes("/dist"),
  });
  cpSync(".github/workflows", join(tooling, ".github/workflows"), { recursive: true });
  cpSync("package.json", join(tooling, "package.json"));
  const require = createRequire(import.meta.url);
  // Offline runtime proof using copies of the installed frozen dependencies;
  // this does not replace a registry/install availability check.
  for (const dependency of ["yaml", "@babel/parser"]) {
    cpSync(
      dirname(require.resolve(dependency + "/package.json")),
      join(tooling, "node_modules", dependency),
      { recursive: true, dereference: true },
    );
  }
  writeFileSync(
    join(tooling, "probe.mjs"),
    `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { qualificationRequiredChildJobs, validateQualificationChildCompleteness } from "./scripts/release-qualification-coverage.mjs";
for (const group of ["cross-os", "live-e2e"]) {
  const context = {
    role: "releaseChecks",
    inputs: { phase: "candidate", rerun_group: group, release_profile: "stable",
      mode: "both", run_release_soak: "false", target_context_ref: "release/2026.11.15" },
    getSource: path => readFileSync(path, "utf8"),
  };
  const required = qualificationRequiredChildJobs(context);
  assert(required.length > 0, group + " must exercise completeness");
  assert(required.some(name => name.includes(group === "cross-os" ? "Linux" : "Docker E2E")));
  const jobs = required.map(name => ({name, status: "completed", conclusion: "success"}));
  validateQualificationChildCompleteness({...context, jobs});
  assert.throws(() => validateQualificationChildCompleteness({...context, jobs: []}), /required job did not succeed/);
}
console.log("qualification completeness verified");`,
  );
  const result = spawnSync("node", ["probe.mjs"], {
    cwd: tooling,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("qualification completeness verified");
});
