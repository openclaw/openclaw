import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const moduleUrl = new URL(
  "../../scripts/lib/release-publish-closeout-preflight.mts",
  import.meta.url,
).href;

function sourceFixture(changelog?: string, version = "2026.9.4") {
  const dir = tempDirs.make("release-closeout-readiness-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: createNestedGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "appcast.xml"), "<rss><channel/></rss>");
  if (changelog !== undefined) {
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  }
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

describe("publication preflight closeout phase", () => {
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
    { state: "unavailable", body: "", admitted: false, status: "WARN" },
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
    if (${JSON.stringify(state)} === 'unavailable') fail('HTTP 404: repository not found');
    const page = Number(new URL('https://api.github.com/' + endpoint).searchParams.get('page'));
    const release = {id: 7, draft: true, prerelease: false,
      tag_name: 'v2026.9.5', html_url: 'https://github.com/openclaw/openclaw/releases/tag/v2026.9.5',
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
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          new URL("../../scripts/tsx.mjs", import.meta.url).href,
          "--input-type=module",
          "-e",
          `
import { inspectPublishReleasePage, inspectStableCloseoutPreflight } from ${JSON.stringify(moduleUrl)};
import { createPublishPreflightGh } from ${JSON.stringify(new URL("../../scripts/lib/release-publish-preflight-evidence.mts", import.meta.url).href)};
import { observeReleaseGitHubState } from ${JSON.stringify(new URL("../../scripts/lib/release-publish-state.mts", import.meta.url).href)};
const input = {repo: 'openclaw/openclaw', tag: 'v2026.9.5', sourceSha: ${JSON.stringify(sha)}, runGh: createPublishPreflightGh()};
let admission;
try { admission = {admitted: true, release: inspectPublishReleasePage(input)}; }
catch (error) { admission = {admitted: false, message: error.message}; }
const observation = observeReleaseGitHubState({...input, repository: input.repo, releaseTag: input.tag, npmDistTag: 'latest'});
const closeout = inspectStableCloseoutPreflight({...input, attempt: '1', runId: '123'});
console.log(JSON.stringify({admission, observation, closeout}));
`,
        ],
        {
          cwd: dir,
          env: { ...createNestedGitEnv(), PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    expect(result.admission.admitted).toBe(admitted);
    expect(result.observation.gates).toContainEqual(
      expect.objectContaining({ id: "github.release", status }),
    );
    if (state === "draft") {
      expect(result.observation.release).toMatchObject({ id: 7, draft: true });
      expect(result.closeout).toContainEqual(
        expect.objectContaining({
          id: "stable-closeout.release-assets",
          status: "WARN",
          message: "GitHub release v2026.9.5 is still a draft.",
        }),
      );
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
      expect(result.observation.gates).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("push access") }),
      );
      expect(result.closeout).toContainEqual(
        expect.objectContaining({ id: "stable-closeout.release-state", status: "WARN" }),
      );
    } else if (state !== "absent") {
      expect(result.observation.gates).toContainEqual(
        expect.objectContaining({ message: "GitHub release state could not be read." }),
      );
    }
  });

  it("reports pending main reconciliation without making it a publication prerequisite", () => {
    const { dir, sha } = sourceFixture();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { inspectStableCloseoutPreflight } from ${JSON.stringify(moduleUrl)};
        const sha=${JSON.stringify(sha)};
        const rows=inspectStableCloseoutPreflight({repo:'openclaw/openclaw',tag:'v2026.9.5',sourceSha:sha,attempt:'1',runId:'123',runGh(args){
          if(args[1].endsWith('git/ref/heads/main')) return JSON.stringify({object:{sha}});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_ID')) return JSON.stringify({value:'verified-fixture-drill'});
          if(args[1].endsWith('RELEASE_ROLLBACK_DRILL_DATE')) return JSON.stringify({value:new Date(Date.now()-86400000).toISOString().slice(0,10)});
          throw new Error('Unexpected read '+args[1]);
        }});
        console.log(JSON.stringify(rows));
      `,
        ],
        { cwd: dir, encoding: "utf8" },
      ),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ id: "stable-closeout.main-source", status: "WARN" }),
    );
    expect(result).not.toContainEqual(expect.objectContaining({ status: "FAIL" }));
  });

  it.each(["absent", "draft"])(
    "validates frozen release notes before admitting an %s release page",
    (releaseState) => {
      const { dir, sha } = sourceFixture(
        `## 2026.9.5\n\n${"oversized release notes ".repeat(6_000)}`,
      );
      const inspect = () =>
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
                import { inspectPublishReleasePage } from ${JSON.stringify(moduleUrl)};
                try {
                  inspectPublishReleasePage({
                    repo: 'openclaw/openclaw', tag: 'v2026.9.5', sourceSha: ${JSON.stringify(sha)},
                    runGh() {
                      if (${JSON.stringify(releaseState)} === 'absent') throw new Error('HTTP 404: Not Found');
                      return JSON.stringify({ draft: true, body: 'Draft notes' });
                    },
                  });
                  console.log(JSON.stringify({ admitted: true }));
                } catch (error) {
                  console.log(JSON.stringify({ admitted: false, message: error.message }));
                }
              `,
            ],
            { cwd: dir, env: createNestedGitEnv(), encoding: "utf8" },
          ),
        );
      expect(inspect()).toMatchObject({
        admitted: false,
        message: expect.stringContaining("release notes exceed GitHub's body limit"),
      });
    },
  );
});
