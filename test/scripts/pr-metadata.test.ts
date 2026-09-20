import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const base = "c".repeat(40);

type Fixture = {
  changedFiles?: number | null;
  files?: unknown;
  initialPatch?: Record<string, unknown>;
  finalPatch?: Record<string, unknown>;
  failure?: "empty" | "exit" | "non-json" | "null" | "quota" | "forbidden";
  failureCount?: number;
  failureTarget?: "pull" | "reread" | "files" | "graphql" | "permission" | "browse" | "checks";
  notify?: boolean;
  ghRepo?: string;
  ghHost?: string;
  configuredHost?: string;
  defaultRepoURL?: string;
  probeGit?: boolean;
  protectedGh?: boolean;
  cleanupFailure?: boolean;
};

function readPrMetadata(fixture: Fixture = {}, command = "pr_meta_json 42") {
  const dir = tempDirs.make("openclaw-pr-metadata-");
  const gh = join(dir, "gh");
  const trace = join(dir, "trace");
  const selectedGit = join(dir, "selected-git");
  const cleanupPreload = join(dir, "fail-adapter-cleanup.cjs");
  if (fixture.cleanupFailure) {
    writeFileSync(
      cleanupPreload,
      `const fs = require("node:fs");
const remove = fs.rmSync;
fs.rmSync = (path, options) => {
  if (String(path).includes("openclaw-pr-gh-git-")) {
    const error = new Error("Synthetic adapter cleanup failure");
    error.code = "EACCES";
    throw error;
  }
  return remove(path, options);
};
require("node:module").syncBuiltinESMExports();
`,
    );
  }
  if (fixture.probeGit) {
    writeFileSync(
      selectedGit,
      "#!/bin/sh\ncase \"$*\" in\n  --version) printf 'selected fixture Git\\n' ;;\n  'remote get-url origin') printf 'https://github.com/origin-owner/origin-repo.git\\n' ;;\n  *) exit 79 ;;\nesac\n",
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho 'poisoned PATH Git' >&2\nexit 79\n", {
      mode: 0o755,
    });
  }
  writeFileSync(trace, "");
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(join(dir, "sleeps"), "");
  writeFileSync(join(dir, "notify"), "");
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = __dirname;
const fixture = JSON.parse(process.env.FAKE_GH_FIXTURE);
fs.appendFileSync(path.join(root, "trace"), JSON.stringify(args) + "\\n");
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const defaultHost = process.env.GH_HOST || fixture.configuredHost || "github.com";
const qualifyRepository = (repository) => repository.startsWith("https://") ? repository
  : "https://" + (repository.split("/").length === 3 ? repository : defaultHost + "/" + repository);
if (args[0] === "browse" && args[1] === "--no-browser") {
  if (fixture.failure === "quota" && fixture.failureTarget === "browse") {
    console.error("HTTP 403: API rate limit exceeded");
    process.exit(1);
  }
  if (fixture.probeGit) {
    const git = require("node:child_process").execFileSync("git", ["--version"], {encoding:"utf8"});
    if (git.trim() !== "selected fixture Git") throw new Error("Wrong Git reached default repository resolver");
  }
  const repoFlag = args.indexOf("--repo");
  const repository = repoFlag >= 0 ? args[repoFlag + 1]
    : process.env.GH_REPO || fixture.defaultRepoURL || "base-owner/base-repo";
  console.log(qualifyRepository(repository));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  const repoFlag = args.indexOf("--repo");
  const repo = repoFlag >= 0 ? args[repoFlag + 1] : args.find((arg) => arg.startsWith("--repo="))?.slice(7);
  if (!repo || qualifyRepository(repo) !== qualifyRepository("base-owner/base-repo")) throw new Error("Writer targeted a different repository");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checks") {
  if (fixture.failure === "quota" && fixture.failureTarget === "checks") {
    console.error("HTTP 403: API rate limit exceeded");
    process.exit(1);
  }
  out([{name:"RATE_LIMIT",bucket:"pending",state:"PENDING"}]);
  process.exit(8);
}
const endpoint = args.find((arg) => arg.startsWith("repos/") || ["graphql", "rate_limit"].includes(arg));
if (args[0] !== "api" || !endpoint) throw new Error("Only explicit REST/GraphQL endpoints are supported");
const hostFlag = args.indexOf("--hostname");
const apiHost = hostFlag >= 0 ? args[hostFlag + 1] : defaultHost;
const repoURL = "https://" + apiHost + "/base-owner/base-repo";
if (fixture.notify) fs.writeSync(3, endpoint + "\\n");
if (endpoint === "rate_limit") {
  out({resources:{graphql:{remaining:0,limit:5000,reset:1800000000},core:{remaining:4900,limit:5000,reset:1800000300}}});
  process.exit(0);
}
const isPull = endpoint === "repos/base-owner/base-repo/pulls/42";
let count = Number(fs.readFileSync(path.join(root,"count"),"utf8"));
if (isPull) fs.writeFileSync(path.join(root,"count"), String(++count));
const failureTarget = fixture.failureTarget || "pull";
const fail = failureTarget === "pull" ? isPull : failureTarget === "reread" ? isPull && count > 1 : failureTarget === "graphql" ? endpoint === "graphql" : failureTarget === "permission" ? endpoint.includes("/collaborators/") : endpoint.includes("/files?");
if (fixture.failure && fail && (fixture.failureCount === undefined || count <= fixture.failureCount)) {
  if (fixture.failure === "forbidden") {
    console.error("HTTP 403: Resource not accessible by integration; secret-response-must-not-escape");
    process.exit(1);
  }
  if (fixture.failure === "quota") {
    console.error("HTTP 403: API rate limit exceeded; secret-response-must-not-escape");
    process.exit(1);
  }
  console.error("HTTP 503: No server is currently available");
  if (fixture.failure === "exit") {
    if (failureTarget === "files") out([[{filename:"src/partial.ts",status:"modified",additions:1,deletions:0}]]);
    process.exit(7);
  }
  if (fixture.failure === "non-json") process.stdout.write("unavailable\\n");
  if (fixture.failure === "null") out(null);
  process.exit(0);
}
if (endpoint === "repos/base-owner/base-repo") {
  out({full_name:"base-owner/base-repo",html_url:repoURL,node_id:"R_base"});
} else if (isPull) {
  const record = {number:42,html_url:repoURL+"/pull/42",state:"open",draft:false,
    base:{sha:"${base}",ref:"main",repo:{id:1}},
    head:{sha:"${head}",ref:"topic",repo:{id:2,name:"fork-repo",full_name:"fork-owner/fork-repo",html_url:"https://"+apiHost+"/fork-owner/fork-repo",owner:{login:"fork-owner"}}},
    user:{login:"contributor"},changed_files:fixture.changedFiles === undefined ? 101 : fixture.changedFiles};
  out({...record,...(count === 1 ? fixture.initialPatch : fixture.finalPatch)});
} else if (endpoint.includes("/files?")) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) throw new Error("Files must be paginated");
  const count = fixture.changedFiles === undefined ? 101 : fixture.changedFiles || 0;
  const files = fixture.files === undefined ? Array.from({length:count},(_,i)=>({filename:"src/file-"+i+".ts",additions:1,deletions:0,status:i===count-1?"removed":"modified"})) : fixture.files;
  out(Array.isArray(files) ? [files.slice(0,100), ...(files.length > 100 ? [files.slice(100)] : [])] : [files]);
} else if (endpoint.includes("/check-runs?")) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) throw new Error("Checks must be paginated");
  out([{check_runs:[{name:"ci",status:"completed",conclusion:"success",details_url:"https://example.test/check"}]},{check_runs:[{name:"lint",status:"in_progress",conclusion:null}]}]);
} else if (endpoint.includes("/status?")) {
  out([{statuses:[{context:"external",state:"pending",target_url:"https://example.test/status"}]}]);
} else throw new Error("Unexpected endpoint " + endpoint);
`,
  );
  chmodSync(gh, 0o755);
  const selectedGh = join(dir, "selected-gh");
  if (fixture.protectedGh) {
    copyFileSync(gh, selectedGh);
    chmodSync(selectedGh, 0o755);
    writeFileSync(gh, "#!/bin/sh\necho 'Unexpected PATH gh route' >&2\nexit 79\n");
  }
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      [
        "set -euo pipefail",
        "source scripts/lib/plain-gh.sh",
        "source scripts/pr-lib/worktree.sh",
        "source scripts/pr-lib/common.sh",
        `sleep() { printf '%s\\n' "$*" >> '${join(dir, "sleeps")}'; }`,
        command,
      ].join("; "),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_GH_FIXTURE: JSON.stringify(fixture),
        FAKE_GH_NOTIFY: join(dir, "notify"),
        GH_REPO: fixture.ghRepo ?? "base-owner/base-repo",
        GH_HOST: fixture.ghHost,
        ...(fixture.probeGit ? { OPENCLAW_PR_GIT: selectedGit } : {}),
        OPENCLAW_GH_BIN: fixture.protectedGh ? selectedGh : "",
        ...(fixture.protectedGh ? { GH_TOKEN: "synthetic-writer-token" } : {}),
        ...(fixture.cleanupFailure
          ? {
              TMPDIR: dir,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(cleanupPreload)}`,
            }
          : {}),
        PATH: `${dir}:${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return {
    ...result,
    attempts: Number(readFileSync(join(dir, "count"), "utf8")),
    notifications: readFileSync(join(dir, "notify"), "utf8"),
    calls: readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
    delays: readFileSync(join(dir, "sleeps"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number),
  };
}

describe("PR metadata through REST", () => {
  it.each([
    {
      name: "qualified repo URL",
      ghRepo: "base-owner/base-repo",
      command:
        "pr_gh_plain repo view --json url --repo https://github.enterprise.invalid/base-owner/base-repo",
      failureTarget: "browse",
      host: "github.enterprise.invalid",
    },
    {
      name: "qualified GH_REPO",
      ghRepo: "github.enterprise.invalid/base-owner/base-repo",
      command: "pr_gh_plain repo view --json url",
      failureTarget: "browse",
      host: "github.enterprise.invalid",
    },
    {
      name: "qualified short repo flag",
      ghRepo: "base-owner/base-repo",
      command:
        "pr_gh_plain pr checks 42 --required --json name,bucket,state -R github.enterprise.invalid/base-owner/base-repo",
      failureTarget: "checks",
      host: "github.enterprise.invalid",
    },
    {
      name: "raw API default",
      ghRepo: "github.enterprise.invalid/base-owner/base-repo",
      command: "pr_gh_plain api repos/base-owner/base-repo/pulls/42",
      failureTarget: "pull",
      host: "",
    },
  ] as const)(
    "probes the failing host for $name without changing API defaults",
    ({ ghRepo, command, failureTarget, host }) => {
      const result = readPrMetadata(
        {
          ghRepo,
          configuredHost: "github.com",
          protectedGh: true,
          failure: "quota",
          failureTarget,
        },
        command,
      );
      expect(result.status, result.stderr).toBe(75);
      expect(result.stdout).toBe("");
      expect(result.calls.filter((args) => args.includes("rate_limit"))).toEqual([
        ["api", ...(host ? ["--hostname", host] : []), "rate_limit"],
      ]);
      expect(result.delays).toEqual([]);
    },
  );
  it("keeps successful GitHub JSON intact when Git adapter cleanup fails", () => {
    const result = readPrMetadata(
      { probeGit: true, cleanupFailure: true },
      'response=$(pr_gh_plain api repos/base-owner/base-repo 2>&1); printf "%s\\n" "$response"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify({
        full_name: "base-owner/base-repo",
        html_url: "https://github.com/base-owner/base-repo",
        node_id: "R_base",
      }) + "\n",
    );
    expect(result.stderr).toBe("");
  });
  it("resolves a protected writer's default repository through its selected gh binary", () => {
    const result = readPrMetadata(
      { ghRepo: "", protectedGh: true },
      "pr_gh_plain repo view --json url; pr_gh_plain pr edit 42 --add-assignee contributor",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ url: "https://github.com/base-owner/base-repo" });
    expect(result.calls.filter((args) => args[0] === "browse")).toHaveLength(2);
    expect(result.calls).toContainEqual([
      "pr",
      "edit",
      "42",
      "--add-assignee",
      "contributor",
      "--repo",
      "https://github.com/base-owner/base-repo",
    ]);
  });
  it("rejects unsupported repository JSON fields", () => {
    const result = readPrMetadata({}, "pr_gh repo view --json unsupported");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unsupported REST repository metadata field: unsupported");
  });
  it.each([
    { command: "pr_gh pr view 42 --json headRefOid --jq .headRefOid", expected: head },
    {
      command: "pr_gh_plain repo view --json nameWithOwner --jq=.nameWithOwner",
      expected: "base-owner/base-repo",
    },
  ])("filters view JSON through the shell: $command", ({ command, expected }) => {
    const result = readPrMetadata({}, command);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(result.stderr).toBe("");
  });
  it("uses gh's configured default for reads and explicitly bound writers with the selected Git", () => {
    const result = readPrMetadata(
      { ghRepo: "", defaultRepoURL: "https://github.com/base-owner/base-repo", probeGit: true },
      "pr_meta_json 42; pr_gh_plain pr edit 42 --add-assignee contributor",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).url).toBe("https://github.com/base-owner/base-repo/pull/42");
    expect(result.calls.filter((args) => args[0] === "browse")).toEqual([
      ["browse", "--no-browser"],
      ["browse", "--no-browser"],
      ["browse", "--no-browser"],
      ["browse", "--no-browser"],
    ]);
    expect(result.calls).toContainEqual([
      "pr",
      "edit",
      "42",
      "--add-assignee",
      "contributor",
      "--repo",
      "https://github.com/base-owner/base-repo",
    ]);
  });
  it.each(["environment", "explicit"])(
    "preserves the %s repository override before gh's default",
    (mode) => {
      const explicit = mode === "explicit" ? " --repo=https://github.com/base-owner/base-repo" : "";
      const result = readPrMetadata(
        {
          ghRepo: mode === "explicit" ? "ignored/repo" : "base-owner/base-repo",
          defaultRepoURL: "https://github.com/ignored/default",
        },
        `pr_gh pr view 42 --json number,headRefOid${explicit}; pr_gh_plain pr edit 42 --add-assignee contributor${explicit}`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ number: 42, headRefOid: head });
      expect(result.calls).toContainEqual(
        mode === "explicit"
          ? ["browse", "--no-browser", "--repo", "https://github.com/base-owner/base-repo"]
          : ["browse", "--no-browser"],
      );
    },
  );
  it.each(
    ["GH_REPO", "--repo"].flatMap((selection) =>
      ["github.enterprise.invalid", "github.enterprise.invalid:8443"].map((enterpriseHost) => ({
        selection,
        enterpriseHost,
      })),
    ),
  )(
    "uses the configured enterprise host $enterpriseHost for unqualified $selection with GH_HOST unset",
    ({ selection, enterpriseHost }) => {
      const repoURL = `https://${enterpriseHost}/base-owner/base-repo`;
      const explicit = selection === "--repo" ? " --repo base-owner/base-repo" : "";
      const result = readPrMetadata(
        {
          ghRepo: selection === "GH_REPO" ? "base-owner/base-repo" : "",
          configuredHost: enterpriseHost,
          defaultRepoURL: repoURL,
          protectedGh: true,
        },
        `pr_gh_plain repo view --json url${explicit}; pr_gh_plain pr edit 42 --add-assignee contributor`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ url: repoURL });
      expect(result.calls).toContainEqual([
        "api",
        "--hostname",
        enterpriseHost,
        "repos/base-owner/base-repo",
        "-H",
        "Cache-Control: max-age=0",
      ]);
      expect(result.calls).toContainEqual([
        "pr",
        "edit",
        "42",
        "--add-assignee",
        "contributor",
        "--repo",
        repoURL,
      ]);
      expect(result.calls).toContainEqual(
        selection === "--repo"
          ? ["browse", "--no-browser", "--repo", "base-owner/base-repo"]
          : ["browse", "--no-browser"],
      );
    },
  );
  it.each(["forbidden", "quota"] as const)(
    "reports %s collaborator lookup failures with the existing preparation policy",
    (failure) => {
      const result = readPrMetadata(
        { failure, failureTarget: "permission" },
        "source scripts/pr-lib/prepare-core.sh; resolve_pr_author_access_at_prepare contributor",
      );
      expect(result.status, result.stderr).toBe(failure === "forbidden" ? 0 : 1);
      expect(result.stdout).toBe(failure === "forbidden" ? "unknown\n" : "");
      expect(result.stderr).toContain("resource=core");
      expect(result.stderr).toContain(
        "graphql 0/5000 reset=2027-01-15T08:00:00Z core 4900/5000 reset=2027-01-15T08:05:00Z",
      );
      expect(result.stderr).toContain(
        "Supplemental quota probe (remaining/limit; not the failing response)",
      );
      expect(result.stderr).not.toContain("Wait until");
      expect(result.stderr).not.toContain("secret-response-must-not-escape");
      expect(result.calls.filter((args) => args.includes("rate_limit"))).toHaveLength(1);
    },
  );
  it.each([undefined, null, 0, -1, 1.5])(
    "refuses CI dispatch when repository IDs are unavailable: %s",
    (id) => {
      const result = readPrMetadata(
        {
          initialPatch: {
            base: { sha: base, ref: "main", repo: { id } },
            head: { sha: head, ref: "topic", repo: { id } },
          },
        },
        "source scripts/pr-lib/gates.sh; ci_dispatch 42",
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("missing repository identity for workflow dispatch");
      expect(result.stdout).toBe("");
      expect(result.calls.some((args) => args[0] === "workflow")).toBe(false);
    },
  );
  it("preserves pending checks exit 8 and JSON without mistaking check names for quota errors", () => {
    const result = readPrMetadata(
      {},
      "pr_gh_plain pr checks 42 --required --json name,bucket,state",
    );
    expect(result.status, result.stderr).toBe(8);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "RATE_LIMIT", bucket: "pending", state: "PENDING" },
    ]);
    expect(result.calls.some((args) => args.includes("rate_limit"))).toBe(false);
  });
  it("forwards lock notifier FD3 through the shell, Node, API call and quota probe", () => {
    const result = readPrMetadata(
      { notify: true, failure: "quota" },
      'exec 3>"$FAKE_GH_NOTIFY"; export OPENCLAW_PR_LOCK_NOTIFY_FD=3; pr_gh api repos/base-owner/base-repo/pulls/42',
    );
    expect(result.status, result.stderr).toBe(75);
    expect(result.notifications).toBe("repos/base-owner/base-repo/pulls/42\nrate_limit\n");
    expect(result.stderr).toContain("resource=core");
  });
  it("collects complete paginated files and exact-head checks without consuming GraphQL", () => {
    const result = readPrMetadata();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.attempts).toBe(2);
    expect(
      result.calls.every(
        (args) =>
          (args[0] === "api" && !args.includes("graphql")) ||
          (args[0] === "browse" && args[1] === "--no-browser"),
      ),
    ).toBe(true);
    const metadata = JSON.parse(result.stdout);
    expect(metadata).toMatchObject({
      number: 42,
      changedFiles: 101,
      headRefOid: head,
      baseRefOid: base,
      headRepository: { nameWithOwner: "fork-owner/fork-repo" },
    });
    expect(metadata.files).toHaveLength(101);
    expect(metadata.files.at(-1)).toEqual({
      path: "src/file-100.ts",
      additions: 1,
      deletions: 0,
      changeType: "DELETED",
    });
    expect(metadata.statusCheckRollup).toMatchObject([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS" },
      { __typename: "StatusContext", context: "external", state: "PENDING" },
    ]);
  });

  it("accepts an explicit empty diff", () => {
    const result = readPrMetadata({ changedFiles: 0 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([]);
  });

  it("preserves renamed paths and change types from REST file pages", () => {
    const result = readPrMetadata({
      changedFiles: 1,
      files: [
        {
          filename: "src/renamed.ts",
          previous_filename: "src/previous.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
      ],
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).files).toEqual([
      { path: "src/renamed.ts", changeType: "RENAMED", additions: 0, deletions: 0 },
    ]);
  });

  it("rejects incomplete file pagination", () => {
    const result = readPrMetadata({
      changedFiles: 2,
      files: [{ filename: "src/file.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("expected 2 changed files, received 1 from paginated REST");
  });

  it("rejects a zero count contradicted by returned files", () => {
    const result = readPrMetadata({
      changedFiles: 0,
      files: [{ filename: "src/file.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("consistent with changedFiles");
  });

  it("does not publish a partial page when the files API fails", () => {
    const result = readPrMetadata({ failure: "exit", failureTarget: "files" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("exited with status 7");
  });

  it.each([null, {}, "unavailable"])("rejects unavailable file pages %j", (files) => {
    const result = readPrMetadata({ changedFiles: 0, files });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("malformed paginated metadata");
  });

  it.each([
    [{ filename: "x", status: "modified", additions: -1, deletions: 0 }],
    [{ filename: "x", status: "modified", additions: 0.5, deletions: 0 }],
    [{ filename: "", status: "modified", additions: 0, deletions: 0 }],
    [
      { filename: "x", status: "modified", additions: 0, deletions: 0 },
      { filename: "x", status: "modified", additions: 0, deletions: 0 },
    ],
  ])("rejects invalid or duplicate entries %j", (...files) => {
    const result = readPrMetadata({ changedFiles: files.length, files });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("files must be an explicit array");
  });

  it.each([
    { number: 43 },
    { html_url: "https://github.com/other/repo/pull/42" },
    { base: { sha: null, ref: "main" } },
    { base: { sha: base, ref: "" } },
    { head: { sha: "not-a-sha", ref: "topic" } },
    { head: { ref: "topic" } },
  ])("rejects mismatched or incomplete PR identity %j", (initialPatch) => {
    const result = readPrMetadata({ initialPatch });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.attempts).toBe(1);
    expect(result.delays).toEqual([]);
  });

  it.each([
    { number: 43 },
    { html_url: "https://github.com/other/repo/pull/42" },
    { base: { sha: "d".repeat(40), ref: "main" } },
    { base: { sha: base, ref: "release" } },
    { head: { sha: head, ref: "different", repo: { full_name: "another/fork" } } },
  ])("rejects changed post-collection identity %j", (finalPatch) => {
    const result = readPrMetadata({ finalPatch });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "base/head or repository identity changed or became unavailable",
    );
  });

  it("rejects files collected while the PR head moves", () => {
    const result = readPrMetadata({ finalPatch: { head: { sha: "b".repeat(40), ref: "topic" } } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PR head changed while collecting file metadata");
  });

  it("rejects an invalid changed-file count", () => {
    const result = readPrMetadata({ changedFiles: null });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changedFiles must be a non-negative integer");
  });

  it.each(["empty", "exit", "non-json", "null"] as const)(
    "keeps the bounded metadata retry for %s responses",
    (failure) => {
      const result = readPrMetadata({ failure });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.attempts).toBe(3);
      expect(result.delays).toEqual([1, 2]);
      expect(result.stderr).toContain("GitHub API failure while reading PR #42");
    },
  );

  it("recovers from a transient metadata failure", () => {
    const result = readPrMetadata({ failure: "empty", failureCount: 1 });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.delays).toEqual([1]);
  });

  it("fails closed when the post-collection identity read is unavailable", () => {
    const result = readPrMetadata({ failure: "exit", failureTarget: "reread" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.attempts).toBe(4);
    expect(result.delays).toEqual([1, 2]);
    expect(result.stderr).toContain("GitHub API failure while reading PR #42");
  });

  it.each([
    { command: "pr_meta_json 42", failureTarget: "pull", resource: "core", exitCode: 1 },
    { command: "ensure_gh_api_auth", failureTarget: "graphql", resource: "graphql", exitCode: 1 },
    {
      command: "pr_gh pr view 42 --json headRefOid --jq .headRefOid",
      failureTarget: "pull",
      resource: "core",
      exitCode: 75,
    },
    {
      command: "pr_gh_plain pr view 42 --json headRefOid --jq=.headRefOid",
      failureTarget: "pull",
      resource: "core",
      exitCode: 75,
    },
  ] as const)(
    "labels supplemental quotas for a $resource failure without retrying: $command",
    ({ command, failureTarget, resource, exitCode }) => {
      const result = readPrMetadata({ failure: "quota", failureTarget }, command);
      expect(result.status).toBe(exitCode);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Supplemental quota probe (remaining/limit; not the failing response)",
      );
      expect(result.stderr).not.toContain("Wait until");
      expect(result.stderr).toContain(`resource=${resource}`);
      expect(result.stderr).toContain(
        "graphql 0/5000 reset=2027-01-15T08:00:00Z core 4900/5000 reset=2027-01-15T08:05:00Z",
      );
      expect(result.stderr).not.toContain("secret-response-must-not-escape");
      expect(result.calls.filter((args) => args.includes("rate_limit"))).toHaveLength(1);
      expect(result.attempts).toBe(failureTarget === "pull" ? 1 : 0);
      expect(result.delays).toEqual([]);
    },
  );
});

describe("merge outcome API diagnostics", () => {
  it.each(["quota", "forbidden", "exit"] as const)(
    "keeps %s diagnostics nonfatal and exposes only bounded access errors",
    (failure) => {
      const observation = JSON.stringify({
        main: base,
        pr: {
          state: "OPEN",
          headRefOid: head,
          baseRefName: "main",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          autoMergeRequest: null,
          isInMergeQueue: false,
        },
      });
      const result = readPrMetadata(
        { failure },
        `MERGE_REPO_HOST=github.com MERGE_REPO_NAME=base-owner/base-repo PREP_HEAD_SHA=${head} merge_outcome_diagnose 42 '${observation}'; printf 'diagnostic completed\\n'`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("diagnostic completed\n");
      expect(result.stderr).toContain(
        "REST pulls/42: mergeable/mergeable_state unavailable (diagnostic only)",
      );
      expect(result.stderr).not.toContain("secret-response-must-not-escape");
      expect(result.stderr).not.toContain("HTTP 503: No server is currently available");
      if (failure === "exit") {
        expect(result.stderr).not.toContain("GitHub API request failed");
      } else {
        expect(result.stderr).toContain("resource=core");
        expect(result.stderr).toContain(
          "graphql 0/5000 reset=2027-01-15T08:00:00Z core 4900/5000 reset=2027-01-15T08:05:00Z",
        );
      }
      expect(result.attempts).toBe(1);
      expect(result.delays).toEqual([]);
      expect(result.calls.filter((args) => args.includes("rate_limit"))).toHaveLength(
        failure === "exit" ? 0 : 1,
      );
      expect(result.calls.every((args) => args[0] === "api")).toBe(true);
    },
  );
});

describe("PR GitHub helper snapshot trust", () => {
  it.each(["changed source", "redirected import root", "changed response parser"])(
    "rejects %s before loading snapshot code",
    (kind) => {
      const root = tempDirs.make("openclaw-pr-gh-snapshot-");
      for (const file of [
        "pr-lib/github.sh",
        "pr-lib/github.mjs",
        "pr-lib/gh-api-preflight.mjs",
        "lib/plain-gh.mjs",
        "lib/direct-run.mjs",
      ]) {
        const target = join(root, "scripts", file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(process.cwd(), "scripts", file), target);
      }
      const target = join(
        root,
        "scripts/pr-lib",
        kind === "changed response parser" ? "gh-api-preflight.mjs" : "github.mjs",
      );
      if (kind !== "redirected import root") {
        writeFileSync(target, "throw new Error('unverified source ran');\n");
      } else {
        const outside = join(root, "outside/github.mjs");
        mkdirSync(dirname(outside));
        copyFileSync(target, outside);
        unlinkSync(target);
        symlinkSync(outside, target);
      }
      const result = spawnSync(
        "/bin/bash",
        ["-c", 'source "$1"', "snapshot-test", join(process.cwd(), "scripts/pr-lib/github.sh")],
        {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: root },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing unverified scripts/pr GitHub helper snapshot");
      expect(result.stderr).not.toContain("unverified source ran");
    },
  );
});
