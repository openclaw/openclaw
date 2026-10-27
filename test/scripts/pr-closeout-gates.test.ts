import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitChangelog, writeReleaseChangelog } from "../../scripts/lib/release-changelog.mjs";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = createTempDirTracker();
const preamble = "# Changelog\n\n";
const history = "## 2026.8.31\n\n### Fixes\n\n- Previous release.\n";
const releaseSection = (version: string) =>
  `## ${version}\n\n### Fixes\n\n- Shipped repair (#42).\n\n`;

const changelog = (section: string) => preamble + section + history;

function runCloseout(options: {
  version?: string;
  branch?: string;
  title?: string;
  base?: string;
  fork?: boolean;
  before?: string;
  after?: string;
  published?: boolean;
  override?: string;
  split?: boolean;
  afterFiles?: Record<string, string>;
  advanceMain?: boolean;
  section?: string;
}) {
  const version = options.version ?? "2026.9.1";
  const dir = tempDirs.make("openclaw-pr-closeout-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-qm", message);
  };
  const writeChangelog = (tag: string, contents: string, section = releaseSection(tag)) => {
    if (options.split) {
      writeReleaseChangelog({ rootDir: repo, version: tag, section });
    } else {
      writeFileSync(join(repo, "CHANGELOG.md"), contents);
    }
  };
  git("init", "-q");
  writeFileSync(join(repo, "CHANGELOG.md"), options.before ?? preamble + history);
  if (options.split) {
    splitChangelog({ rootDir: repo });
  }
  commit("base");
  let mainSha = git("rev-parse", "HEAD");
  // A real local tag alone must not authorize closeout: origin owns publication.
  if (options.published !== false) {
    git("tag", `v${version}`);
  }
  git("clone", "-q", "--bare", ".", join(dir, "origin.git"));
  git("remote", "add", "origin", join(dir, "origin.git"));
  if (options.published === false) {
    git("tag", `v${version}`);
  }
  const after = options.after ?? changelog(releaseSection(version));
  writeChangelog(version, after, options.section);
  for (const [file, content] of Object.entries(options.afterFiles ?? {})) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  commit("closeout");
  if (options.advanceMain) {
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", mainSha);
    writeChangelog("2026.9.2", changelog(releaseSection("2026.9.2")));
    commit("new main release");
    mainSha = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", head);
  }
  mkdirSync(join(repo, ".local"));
  writeFileSync(join(repo, ".local/pr-meta.env"), "PR_AUTHOR=alice\n");
  const metadata = {
    headRefName: options.branch ?? `release/${version}-main-closeout`,
    title: options.title ?? `chore(release): close out ${version} on main`,
    baseRefName: options.base ?? "main",
    headRefOid: git("rev-parse", "HEAD"),
    isCrossRepository: options.fork ?? false,
  };
  writeFileSync(join(repo, "metadata.json"), JSON.stringify(metadata));
  writeFileSync(
    join(repo, ".local/gates-hosted-checks.json"),
    JSON.stringify({ headSha: metadata.headRefOid }),
  );
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'browse') {
  console.log('https://github.com/openclaw/openclaw');
  process.exit(0);
}
const endpoint = args.find(arg => arg.startsWith('repos/'));
if (args[0] !== 'api') throw new Error('Unexpected GitHub command: ' + args.join(' '));
const metadata = JSON.parse(readFileSync('metadata.json', 'utf8'));
const repository = { id: 1, node_id: 'fixture-repo', full_name: 'openclaw/openclaw', html_url: 'https://github.com/openclaw/openclaw' };
let value;
if (endpoint === 'repos/openclaw/openclaw') value = repository;
else if (endpoint === 'repos/openclaw/openclaw/pulls/42') {
  appendFileSync('gh-calls.log', args.join(' ') + '\\n');
  value = {
    number: 42, title: metadata.title, state: 'open', draft: false,
    head: { ref: metadata.headRefName, sha: metadata.headRefOid, repo: repository },
    base: { ref: metadata.baseRefName, sha: ${JSON.stringify(mainSha)}, repo: { ...repository, id: metadata.isCrossRepository ? 2 : 1 } },
  };
} else if (endpoint === 'repos/openclaw/openclaw/pulls/42/files?per_page=100') value = [[]];
else if (endpoint === 'repos/openclaw/openclaw/commits/' + metadata.headRefOid + '/check-runs?filter=latest&per_page=100') value = [{ check_runs: [] }];
else if (endpoint === 'repos/openclaw/openclaw/commits/' + metadata.headRefOid + '/status?per_page=100') value = [{ statuses: [] }];
else throw new Error('Unexpected GitHub endpoint: ' + endpoint);
console.log(JSON.stringify(value));
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
source "$SCRIPTS/pr-lib/common.sh"
source "$SCRIPTS/pr-lib/changelog.sh"
source "$SCRIPTS/pr-lib/gates.sh"
source "$SCRIPTS/pr-lib/review.sh"
enter_worktree() { PR_MAIN_SHA="$MAIN_SHA"; }
refresh_prep_branch_for_reviewed_head() { :; }
checkout_prep_branch() { :; }
# Review authority is covered by the preparation fixtures; this isolates release classification.
require_prepared_review() { :; }
run_quiet_logged() {
  if [ "$1" = 'hosted CI/Testbox gates' ]; then
    jq -se --slurpfile expected metadata.json '
      length == 1 and
      (.[0] | {headRefName,title,baseRefName,headRefOid,isCrossRepository}) == $expected[0]
    ' >/dev/null || return 1
  fi
  printf 'gate:%s\\n' "$1"
}
prepare_gates 42
`,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SCRIPTS: join(repoRoot, "scripts"),
        MAIN_SHA: mainSha,
        GH_REPO: "openclaw/openclaw",
        OPENCLAW_GH_BIN: join(bin, "gh"),
        OPENCLAW_TESTBOX: "1",
        OPENCLAW_PR_GATES_REMOTE: "",
        OPENCLAW_ALLOW_ROOT_CHANGELOG_PR: options.override ?? "",
      },
    },
  );
  return { result, repo, after };
}

afterEach(() => tempDirs.cleanup());

describe("release closeout prepare gates", () => {
  it("accepts only the selected split release and its matching record", () => {
    const record =
      "### Complete contribution record\n\n- Human contribution (#42). Thanks @alice.\n";
    const { result, repo } = runCloseout({
      split: true,
      afterFiles: {
        "CHANGELOG/2026.9.1.md": releaseSection("2026.9.1") + record,
        "CHANGELOG/records/2026.9.1.md": "## 2026.9.1\n\n" + record,
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("changelog_only=true");
    expect(readFileSync(join(repo, "CHANGELOG/2026.9.1.md"), "utf8")).toBe(
      releaseSection("2026.9.1") + record,
    );
  });

  type Options = Parameters<typeof runCloseout>[0];
  const record = "### Complete contribution record\n\n- Credit (#42). Thanks @alice.\n";
  const changedFile = (path: string, content: string): Options => ({
    split: true,
    afterFiles: { [path]: content },
  });
  const rejectionCases: [string, Options, boolean?][] = [
    [
      "ordinary release edit",
      {
        split: true,
        branch: "fix/notes",
        before: changelog(releaseSection("2026.9.1").replace("Shipped", "Draft")),
      },
    ],
    [
      "older release",
      changedFile("CHANGELOG/2026.8.31.md", history.replace("Previous", "Changed")),
    ],
    ["unrelated file", changedFile("CHANGELOG/notes.md", "unrelated\n")],
    ["index rewrite", changedFile("CHANGELOG.md", "# Rewritten index\n")],
    [
      "mismatched record",
      changedFile(
        "CHANGELOG/records/2026.9.1.md",
        "## 2026.9.1\n\n### Complete contribution record\n\n- Lost credit.\n",
      ),
    ],
    ["main snapshot", { advanceMain: true }],
    ["split main snapshot", { split: true, advanceMain: true }],
    [
      "frozen record",
      {
        ...changedFile(
          "CHANGELOG/records/2026.9.1.md",
          "## 2026.9.1\n\n" + record.replace("alice", "bob"),
        ),
        branch: "fix/record",
        before: changelog(releaseSection("2026.9.1") + record + "\n"),
        section: releaseSection("2026.9.1") + record,
      },
      true,
    ],
    ["title", { title: "chore: release" }, true],
    ["target", { base: "release/2026.9.1" }, true],
    ["fork", { fork: true }, true],
    ["beta", { version: "2026.9.1-beta.1" }, true],
    ["local tag", { published: false }, true],
    ["section version", { after: changelog(releaseSection("2026.9.2")) }, true],
    ["newer train", { before: changelog(releaseSection("2026.9.2 (Unreleased)")) }, true],
    [
      "old history",
      { after: changelog(releaseSection("2026.9.1")).replace("Previous", "Changed") },
      true,
    ],
    ["duplicate sections", { after: changelog(releaseSection("2026.9.1").repeat(2)) }, true],
  ];
  it.each(rejectionCases)("rejects %s", (_name, options, releaseOwned) => {
    const { result } = runCloseout(options);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    if (releaseOwned) {
      expect(result.stdout).toContain("CHANGELOG.md is release-owned");
    }
    expect(result.stdout).not.toContain("gate:hosted");
  });

  it.each([
    { name: "accepts stable correction tags", version: "2026.9.1-2" },
    {
      name: "finalizes an earlier correction draft",
      version: "2026.9.1-10",
      before: changelog(releaseSection("2026.9.1-2 (Unreleased)")),
    },
    {
      name: "preserves a newer unreleased train while adding the shipped release",
      before: changelog(releaseSection("2026.9.2 (Unreleased)")),
      after:
        preamble + releaseSection("2026.9.1") + releaseSection("2026.9.2 (Unreleased)") + history,
    },
  ])("$name without an override and preserves tagged text", ({ name: _name, ...options }) => {
    const { result, repo, after } = runCloseout(options);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("gate:hosted CI/Testbox gates");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(after);
    expect(readFileSync(join(repo, "gh-calls.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retains the explicit release automation override", () => {
    const { result, repo, after } = runCloseout({
      branch: "release/automation",
      published: false,
      override: "1",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(after);
  });

  it("checks large release history without a subprocess output limit", () => {
    const largeHistory = history + "- Historical release note.\n".repeat(170_000);
    const { result } = runCloseout({
      before: preamble + largeHistory,
      after: preamble + releaseSection("2026.9.1") + largeHistory,
    });
    expect(result.status).toBe(0);
  });
});
