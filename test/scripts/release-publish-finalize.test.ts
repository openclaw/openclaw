import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as fixtureIO from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceSha = "b".repeat(40);
const signedTagObjectSha = "d".repeat(40);
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
  actualSha = sourceSha,
  latest = tag,
}: {
  tag?: string;
  distTag?: string;
  draft?: boolean;
  prerelease?: boolean;
  actualSha?: string;
  latest?: string;
} = {}) {
  const root = tempDirs.make("release-publish-finalize-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "calls"), "");
  writeFileSync(join(root, "summary"), "");
  for (const binary of ["gh", "node", "git"]) {
    fixtureIO.writeExecutable(
      join(bin, binary),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const [command, subcommand] = args;
const tool = ${JSON.stringify(binary)};
appendFileSync(process.env.RUNNER_TEMP + '/calls', JSON.stringify([${JSON.stringify(binary)}, ...args]) + '\\n');
const routes = [
  [tool === 'node' && command === 'scripts/linux-updater-manifest.mjs' && subcommand === 'carry', []],
  [tool === 'node' && command === 'scripts/release-tooling-identity.mjs' && subcommand === 'verify', []],
  [tool === 'node' && command === 'scripts/linux-app-channel.mjs' && subcommand === 'finalize-core', [JSON.stringify({ state: 'finalized' })]],
  [tool === 'gh' && command === 'api' && subcommand.includes('/commits/'), [${JSON.stringify(actualSha)}]],
  [tool === 'gh' && command === 'api' && subcommand.endsWith('/releases/latest'), [${JSON.stringify(latest)}]],
  [tool === 'gh' && command === 'release' && subcommand === 'view', [JSON.stringify(${JSON.stringify({ isDraft: draft, isPrerelease: prerelease })})]],
  [tool === 'git', [
    ${JSON.stringify(signedTagObjectSha)} + '\\trefs/tags/' + process.env.RELEASE_TAG,
    ${JSON.stringify(actualSha)} + '\\trefs/tags/' + process.env.RELEASE_TAG + '^{}',
  ]],
];
const route = routes.find(([matches]) => matches);
if (!route) throw new Error('Unexpected operation: ' + JSON.stringify(args));
for (const line of route[1]) console.log(line);
`,
    );
  }
  const result = fixtureIO.runProcess("bash", ["-c", finalize], {
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary"),
    GITHUB_REPOSITORY: "openclaw/openclaw",
    GITHUB_REF_NAME: "main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    PARENT_WORKFLOW_SHA: "a".repeat(40),
    RELEASE_TAG: tag,
    RELEASE_NPM_DIST_TAG: distTag,
    SIGNED_RELEASE_TAG_OBJECT_SHA: signedTagObjectSha,
    SOURCE_SHA: sourceSha,
    TARGET_SHA: sourceSha,
  });
  const evidencePath = join(root, "core-finalization.json");
  const calls = fixtureIO.readJsonLines<string[]>(join(root, "calls"));
  return {
    ...result,
    calls,
    nodeCalls: calls.filter(([binary]) => binary === "node"),
    summary: readFileSync(join(root, "summary"), "utf8"),
    evidence: existsSync(evidencePath)
      ? (fixtureIO.readJson(evidencePath) as Record<string, unknown>)
      : undefined,
  };
}

it.each([
  { tag: "v2026.9.6", distTag: "latest", prerelease: false, madeLatest: true },
  { tag: "v2026.9.7-beta.1", distTag: "beta", prerelease: true, madeLatest: false },
  { tag: "v2026.8.33", distTag: "extended-stable", prerelease: false, madeLatest: false },
])("records verified public $tag without rewriting it", ({ madeLatest, ...options }) => {
  expect(finalizationSteps("finalize_github_release_before_docker")).toEqual(
    finalizationSteps("finalize_github_release"),
  );
  const result = fixture(options);
  expect(result.status, result.stderr).toBe(0);
  expect(result.evidence).toEqual({
    state: "already-public",
    tag: options.tag,
    sourceSha,
    madeLatest,
  });
  expect(result.summary).toContain("GitHub release: already public; verified, not rewritten");
  expect(result.nodeCalls).toEqual(
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
  expect(result.nodeCalls.map((args) => args[2])).toEqual(["carry", "verify", "finalize-core"]);
  expect(result.summary).not.toContain("already public");
});

it("refuses a moved public tag before admitting the idempotent result", () => {
  const result = fixture({ actualSha: "c".repeat(40) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`Release tag v2026.9.6 moved: expected ${sourceSha}`);
  expect(result.evidence).toBeUndefined();
  expect(result.nodeCalls).toEqual([]);
});
