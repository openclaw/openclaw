import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureGit, expectGate } from "./release-publish.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = (name: string) => new URL(`../../scripts/lib/${name}.mts`, import.meta.url).href;
const loader = new URL("../../scripts/tsx.mjs", import.meta.url).href;

function evaluate(
  { dir, sha, toolingSha = sha }: { dir: string; sha: string; toolingSha?: string },
  expression: string,
  bin?: string,
) {
  const source = `
import { inspectPublishReleasePage, inspectStableCloseoutPreflight } from ${JSON.stringify(moduleUrl("release-publish-closeout-preflight"))};
import { createPublishPreflightGh } from ${JSON.stringify(moduleUrl("release-publish-preflight-evidence"))};
import { observeReleaseGitHubState } from ${JSON.stringify(moduleUrl("release-publish-state"))};
const input = {repo: 'openclaw/openclaw', tag: 'v2026.9.5', sourceSha: ${JSON.stringify(sha)}, toolingSha: ${JSON.stringify(toolingSha)}, runGh: createPublishPreflightGh()};
const closeoutInput = {...input, attempt: '1', runId: '123'};
const admit = async (changes = {}) => {
  try { return {admitted: true, release: await inspectPublishReleasePage({...input, ...changes})}; }
  catch (error) { return {admitted: false, message: error.message}; }
};
console.log(JSON.stringify(await (${expression})));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
      cwd: dir,
      env: {
        ...createNestedGitEnv(),
        ...(bin ? { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } : {}),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function sourceFixture(changelog?: string, version = "2026.9.4", toolingVersion?: string) {
  const dir = tempDirs.make("release-closeout-readiness-");
  const git = fixtureGit(dir, "Test", "test@example.invalid");
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "appcast.xml"), "<rss><channel/></rss>");
  if (changelog !== undefined) {
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD");
  if (toolingVersion) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: toolingVersion }));
    git("commit", "-qam", "publisher tooling");
  }
  return { dir, sha, toolingSha: git("rev-parse", "HEAD") };
}

it.skipIf(process.platform === "win32").each([
  { state: "draft", body: "", admitted: true, status: "WARN" },
  { state: "draft", body: null, admitted: true, status: "WARN" },
  {
    state: "draft",
    body: "<!-- openclaw-release-publication:docs-v1 -->",
    admitted: false,
    status: "WARN",
  },
  { state: "absent", body: "", admitted: true, status: "PASS" },
  { state: "forbidden", body: "", admitted: false, status: "WARN" },
  { state: "limited", body: "", admitted: true, status: "WARN" },
])("shares draft-aware release lookup for $state/$body", ({ state, body, admitted, status }) => {
  const { dir, sha } = sourceFixture(
    "## 2026.9.5\n\n### Fixes\n\n- Correct release behavior.\n",
    "2026.9.5",
  );
  const bin = join(dir, "bin");
  const calls = join(dir, "gh-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(calls, "");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
function fail(message) { console.error(message); process.exit(1); }
if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/releases/tags/')) fail('HTTP 404: Not Found');
  else if (endpoint.includes('/releases?')) {
    if (${JSON.stringify(state)} === 'forbidden') fail('HTTP 403: Forbidden');
    const page = Number(new URL('https://api.github.com/' + endpoint).searchParams.get('page'));
    const release = {id: 7, draft: true, prerelease: false, tag_name: 'v2026.9.5',
      html_url: 'https://github.com/openclaw/openclaw/releases/tag/v2026.9.5',
      target_commitish: ${JSON.stringify(sha)}, body: ${JSON.stringify(body)}, assets: []};
    console.log(JSON.stringify(${JSON.stringify(state)} !== 'draft' ? [] : page === 1
      ? Array.from({length: 100}, (_, index) => ({tag_name: 'other-' + index})) : [release]));
  }
  else if (endpoint === 'repos/openclaw/openclaw') console.log(JSON.stringify({permissions: ${JSON.stringify(state)} === 'limited' ? null : {push: true}}));
  else if (endpoint.includes('/actions/workflows/')) console.log(JSON.stringify({total_count: 0, workflow_runs: []}));
  else if (endpoint.endsWith('git/ref/heads/main')) console.log(JSON.stringify({object: {sha: ${JSON.stringify(sha)}}}));
  else if (endpoint.endsWith('RELEASE_ROLLBACK_DRILL_ID')) console.log(JSON.stringify({value: 'fixture-drill'}));
  else if (endpoint.endsWith('RELEASE_ROLLBACK_DRILL_DATE')) console.log(JSON.stringify({value: new Date(Date.now()-86400000).toISOString().slice(0,10)}));
  else fail('Unexpected endpoint: ' + endpoint);
} else fail('Unexpected gh command');
`,
    { mode: 0o755 },
  );
  const result = evaluate(
    { dir, sha },
    `({admission: await admit(),
observation: observeReleaseGitHubState({...input, repository: input.repo, releaseTag: input.tag, npmDistTag: 'latest'}),
closeout: inspectStableCloseoutPreflight(closeoutInput)})`,
    bin,
  );
  expect(result.admission.admitted).toBe(admitted);
  expectGate(result.observation.gates, { id: "github.release", status });
  if (state === "draft") {
    expectGate(result.closeout, {
      id: "stable-closeout.release-assets",
      status: "WARN",
      message: "GitHub release v2026.9.5 is still a draft.",
    });
    const releaseReads = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((args) => args[1].includes("/releases?"));
    expect(releaseReads).toHaveLength(2);
    if (body) {
      expect(result.admission.message).toContain("docs-publication owner");
    }
  } else if (state === "limited") {
    expectGate(result.observation.gates, { message: expect.stringContaining("push access") });
    expectGate(result.closeout, { id: "stable-closeout.release-state", status: "WARN" });
  } else if (state !== "absent") {
    expectGate(result.observation.gates, {
      message: expect.stringContaining("GitHub release state could not be read:"),
    });
  }
});

it("reports pending main reconciliation without making it a publication prerequisite", () => {
  const fixture = sourceFixture();
  const result = evaluate(
    fixture,
    `inspectStableCloseoutPreflight({...closeoutInput,runGh(args){
          if(args[1].endsWith('git/ref/heads/main')) return JSON.stringify({object:{sha:input.sourceSha}});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_ID')) return JSON.stringify({value:'verified-fixture-drill'});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_DATE')) return JSON.stringify({value:new Date(Date.now()-86400000).toISOString().slice(0,10)});
          throw new Error('Unexpected read '+args[1]);
        }})`,
  );
  expectGate(result, { id: "stable-closeout.main-source", status: "WARN" });
  expect(result).not.toContainEqual(expect.objectContaining({ status: "FAIL" }));
});

it("validates frozen release notes before looking up the release page", () => {
  const fixture = sourceFixture(`## 2026.9.5\n\n${"oversized release notes ".repeat(6_000)}`);
  const result = evaluate(
    fixture,
    `admit({runGh() { throw new Error('Release lookup must follow notes validation'); }})`,
  );
  expect(result).toMatchObject({
    admitted: false,
    message: expect.stringContaining("release notes exceed GitHub's body limit"),
  });
});

it.each([
  ["2026.10.5", undefined, false, true],
  ["2026.11.5", undefined, false, false],
  ["2026.11.5", "Maintainer approved this retired maintenance release.", false, true],
  ["2026.11.5", "Maintainer approved this retired maintenance release.", true, true],
])(
  "renders and verifies extended-stable notes: %s/%s/%s",
  (latest, reason, publicPage, admitted) => {
    const fixture = sourceFixture(
      "## 2026.9.37\n\n### Fixes\n\n- Correct release behavior.\n",
      "2026.9.37",
      latest,
    );
    const body =
      "This is a gateway-only `extended-stable` release, published from a retired maintenance line by explicit maintainer decision. This release is OpenClaw from the end of September 2026, plus critical security updates, reliability and performance fixes, and features like new model support. The latest version of OpenClaw at the time of this release is [2026.11.5](https://github.com/openclaw/openclaw/releases#release-v2026.11.5)\n\n## 2026.9.37\n\n### Fixes\n\n- Correct release behavior.";
    const result = evaluate(
      fixture,
      [
        "(async () => {",
        "globalThis.fetch = async () => { throw new Error('Canonical readback must not follow a moving registry selector'); };",
        "return admit({tag:'v2026.9.37', retiredLineReason:" +
          JSON.stringify(reason) +
          ", runGh(args) {",
        "if (args[1].includes('/releases/tags/')) {",
        "if (!" + publicPage + ") throw new Error('HTTP 404: Not Found');",
        "return JSON.stringify({id:1, tag_name:'v2026.9.37', draft:false, prerelease:false, html_url:'https://github.com/openclaw/openclaw/releases/tag/v2026.9.37', target_commitish:input.sourceSha, body:" +
          JSON.stringify(body) +
          ", assets:[{name:'openclaw-2026.9.37-dependency-evidence.zip'}]});}",
        "if(args[1].includes('/releases?')) return '[]';",
        "return JSON.stringify({permissions:{push:true}});}});})()",
      ].join("\n"),
    );
    expect(result.admitted, result.message).toBe(admitted);
    if (!admitted) {
      expect(result.message).toContain("retired");
    }
  },
);
