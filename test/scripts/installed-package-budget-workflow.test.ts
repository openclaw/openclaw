import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};

const workflow = parse(readFileSync(".github/workflows/installed-package-budget.yml", "utf8"));
const job = workflow.jobs["installed-package-budget"];
const steps: Step[] = job.steps;

function step(name: string): Step {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("installed package budget workflow", () => {
  it("measures every main push without path, opt-in, or concurrency suppression", () => {
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.concurrency).toBeUndefined();
    expect(job.concurrency).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(steps[0].with).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
  });

  it("builds the full package before checking a real global installation", () => {
    const build = step("Build full release-style package");
    const check = step("Install and enforce shipped-updater headroom");
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(check));
    expect(build.run).toContain("node scripts/package-openclaw-for-docker.mjs");
    expect(build.run).not.toMatch(/--skip-build|build:ci-artifacts|--bundle-plugins/);
    expect(build.env).toEqual({
      OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
      OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS: "7200000",
    });
    expect(check.run).toContain('"$PWD" bare');
    expect(check.run).toContain(':/app/scripts/check-openclaw-installed-package-budget.mts:ro"');
    expect(check.run).toContain('npm i -g --allow-scripts=openclaw --prefix "$prefix"');
    expect(check.run).toContain("--no-fund --no-audit --loglevel=error --min-release-age=0");
    expect(check.run).toContain(
      'node scripts/check-openclaw-installed-package-budget.mts "$prefix/lib/node_modules/openclaw"',
    );
    // tee must not turn an over-budget installation into a successful job.
    expect(check.run).toContain("set -euo pipefail");
    for (const required of [build, check]) {
      expect(required.if).toBeUndefined();
      expect(required["continue-on-error"]).toBeUndefined();
    }
    expect(step("Preserve installed-tree measurement").if).toBe("always()");
    expect(step("Upload installed-tree measurement").if).toBe("always()");
  });
});
