import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceSha = "b".repeat(40);
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8")) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};
const finalizationSteps = (job: string) => workflow.jobs[job]!.steps;
const finalize = finalizationSteps("finalize_github_release").find(
  (step) => step.name === "Publish the verified draft release",
)!.run!;

function fixture({
  tag = "v2026.9.6",
  distTag = "latest",
  draft = false,
  prerelease = false,
  latest = tag,
  actualSha = sourceSha,
}: {
  tag?: string;
  distTag?: string;
  draft?: boolean;
  prerelease?: boolean;
  latest?: string;
  actualSha?: string;
} = {}) {
  const root = tempDirs.make("release-publish-finalize-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "summary"), "");
  for (const binary of ["gh", "node"]) {
    writeFileSync(
      join(bin, binary),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.RUNNER_TEMP + '/calls', JSON.stringify([${JSON.stringify(binary)}, ...args]) + '\\n');
if (${JSON.stringify(binary)} === 'node') {
  if (args[0] === 'scripts/linux-updater-manifest.mjs' && args[1] === 'carry') process.exit(0);
  if (args[0] === 'scripts/release-tooling-identity.mjs' && args[1] === 'verify') process.exit(0);
  if (args[0] === 'scripts/linux-app-channel.mjs' && args[1] === 'finalize-core') {
    console.log(JSON.stringify({ state: 'finalized' })); process.exit(0);
  }
} else {
  if (args[0] === 'api' && args[1].includes('/commits/')) { console.log(${JSON.stringify(actualSha)}); process.exit(0); }
  if (args[0] === 'api' && args[1].endsWith('/releases/latest')) { console.log(${JSON.stringify(latest)}); process.exit(0); }
  if (args[0] === 'release' && args[1] === 'view') {
    console.log(JSON.stringify(${JSON.stringify({ isDraft: draft, isPrerelease: prerelease })})); process.exit(0);
  }
}
throw new Error('Unexpected operation: ' + JSON.stringify(args));
`,
      { mode: 0o755 },
    );
  }
  const result = spawnSync("bash", ["-c", finalize], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_STEP_SUMMARY: join(root, "summary"),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF_NAME: "main",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      RELEASE_TAG: tag,
      RELEASE_NPM_DIST_TAG: distTag,
      SOURCE_SHA: sourceSha,
    },
  });
  const evidencePath = join(root, "core-finalization.json");
  return {
    ...result,
    calls: readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]),
    summary: readFileSync(join(root, "summary"), "utf8"),
    evidence: existsSync(evidencePath)
      ? (JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
      : undefined,
  };
}

describe("release publish finalization", () => {
  it("shares idempotent finalization between both activation routes", () => {
    expect(finalizationSteps("finalize_github_release_before_docker")).toEqual(
      finalizationSteps("finalize_github_release"),
    );
    expect(finalize).toContain("already-public");
    expect(finalize).toContain("finalize-core");
  });

  it.each([
    { tag: "v2026.9.6", distTag: "latest", prerelease: false, madeLatest: true },
    { tag: "v2026.9.7-beta.1", distTag: "beta", prerelease: true, madeLatest: false },
    { tag: "v2026.9.7-alpha.1", distTag: "alpha", prerelease: true, madeLatest: false },
    { tag: "v2026.8.33", distTag: "extended-stable", prerelease: false, madeLatest: false },
  ])("records verified public $tag without rewriting it", ({ madeLatest, ...options }) => {
    const result = fixture(options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence).toEqual({
      state: "already-public",
      tag: options.tag,
      sourceSha,
      madeLatest,
    });
    expect(result.summary).toContain("GitHub release: already public; verified, not rewritten");
    expect(result.calls.filter(([binary]) => binary === "node")).toEqual(
      madeLatest ? [expect.arrayContaining(["scripts/linux-updater-manifest.mjs", "carry"])] : [],
    );
    expect(result.calls.some((args) => args.some((arg) => arg.endsWith("/releases/latest")))).toBe(
      madeLatest,
    );
  });

  it.each([
    { label: "draft release", draft: true },
    { label: "different prerelease classification", prerelease: true },
    { label: "different latest release", latest: "v2026.9.5" },
  ])("keeps the authorized writer path for a $label", ({ label: _label, ...options }) => {
    const result = fixture(options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.evidence).toEqual({ state: "finalized" });
    expect(result.calls.filter(([binary]) => binary === "node").map((args) => args[2])).toEqual([
      "carry",
      "verify",
      "finalize-core",
    ]);
    expect(result.summary).not.toContain("already public");
  });

  it("refuses a moved public tag before admitting the idempotent result", () => {
    const result = fixture({ actualSha: "c".repeat(40) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release tag moved before activation");
    expect(result.evidence).toBeUndefined();
    expect(result.calls.filter(([binary]) => binary === "node").map((args) => args[2])).toEqual([
      "carry",
    ]);
  });
});
