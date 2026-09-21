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

function graphqlResponse(repository: unknown) {
  return { data: { repository } };
}

function connectionPage(nodes: unknown[], hasNextPage: boolean) {
  return {
    nodes,
    totalCount: 2,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null },
  };
}

type Fixture = {
  changedFiles?: number | null;
  files?: unknown;
  initialPatch?: Record<string, unknown>;
  finalPatch?: Record<string, unknown>;
  failure?: "empty" | "exit" | "non-json" | "null" | "quota" | "forbidden";
  failureCount?: number;
  failureTarget?:
    | "pull"
    | "reread"
    | "files"
    | "user"
    | "permission"
    | "browse"
    | "checks"
    | "repository";
  cacheUntilRevalidated?: boolean;
  notify?: boolean;
  ghRepo?: string;
  ghHost?: string;
  configuredHost?: string;
  defaultRepoURL?: string;
  probeGit?: boolean;
  protectedGh?: boolean;
  cleanupFailure?: boolean;
  authorSources?: unknown;
  authorPages?: unknown[];
  coreQuotaAt?: string[];
  graphqlResponses?: unknown[];
  graphqlQuota?: boolean;
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
      "#!/bin/sh\ncase \"$*\" in\n  --version) printf 'selected fixture Git\\n' ;;\n  *) exit 79 ;;\nesac\n",
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho 'poisoned PATH Git' >&2\nexit 79\n", {
      mode: 0o755,
    });
  }
  writeFileSync(trace, "");
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(join(dir, "graphql-count"), "0");
  writeFileSync(join(dir, "graphql-inputs"), "");
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
const qualifyRepository = (repository) => {
  repository = repository.replace(/\\.git$/, "");
  return repository.startsWith("https://") ? repository
    : "https://" + (repository.split("/").length === 3 ? repository : defaultHost + "/" + repository);
};
const operation = args[0] === "browse" ? "browse" : args.find((arg) => arg.startsWith("repos/") || arg === "user");
if (fixture.coreQuotaAt?.includes(operation) && (operation !== "browse" || args.includes("--no-browser"))) {
  if (operation === "browse") {
    console.error("HTTP 403: Forbidden (https://api.github.com/repos/base-owner/base-repo)");
    process.exit(1);
  }
  console.log('HTTP/2 403 Forbidden\\nX-RateLimit-Resource: core\\nX-RateLimit-Remaining: 0\\n\\n'+JSON.stringify({message:"API rate limit exceeded"}));
  console.error("gh: API rate limit exceeded");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "view") {
  throw new Error("Top-level pr view can spend REST quota again; use the GraphQL endpoint");
}
if (args[0] === "api" && args.includes("graphql")) {
  if (args.includes("--input")) fs.appendFileSync(path.join(root,"graphql-inputs"),JSON.stringify(JSON.parse(fs.readFileSync(0,"utf8")))+"\\n");
  if (fixture.graphqlQuota) {
    console.error("gh: API rate limit exceeded");
    process.exit(1);
  }
  const count = Number(fs.readFileSync(path.join(root,"graphql-count"),"utf8"));
  fs.writeFileSync(path.join(root,"graphql-count"),String(count+1));
  if (!fixture.graphqlResponses || count >= fixture.graphqlResponses.length) throw new Error("Unexpected GraphQL request");
  if (args.includes("--include")) process.stdout.write("HTTP/2 200 OK\\n\\n");
  let response = fixture.graphqlResponses[count];
  if (fixture.cacheUntilRevalidated && !args.includes("Cache-Control: max-age=0") && response.data?.repository?.pullRequest?.headRefOid) {
    response = fixture.graphqlResponses[0];
  }
  out(response);
  process.exit(0);
}
if (args[0] === "browse") {
  if (!args.includes("--no-browser") && !process.env.GH_BROWSER) {
    throw new Error("Repository discovery must not open the configured browser");
  }
  if (args.includes("--no-browser") && fixture.failure === "quota" && fixture.failureTarget === "browse") {
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
const endpoint = args.find((arg) => arg.startsWith("repos/") || ["user", "rate_limit"].includes(arg));
if (args[0] !== "api" || !endpoint) throw new Error("Only explicit REST endpoints are supported");
const hostFlag = args.indexOf("--hostname");
const apiHost = hostFlag >= 0 ? args[hostFlag + 1] : defaultHost;
const repoURL = "https://" + apiHost.toLowerCase() + "/base-owner/base-repo";
if (fixture.notify) fs.writeSync(3, endpoint + "\\n");
if (endpoint.startsWith("repos/base-owner/base-repo/commits?")) {
  const count = Number(fs.readFileSync(path.join(root, "count"), "utf8"));
  fs.writeFileSync(path.join(root, "count"), String(count + 1));
  if (!fixture.authorPages || count >= fixture.authorPages.length) throw new Error("Unexpected author request");
  out(fixture.authorPages[count]);
  process.exit(0);
}
if (endpoint === "rate_limit") {
  out({resources:{graphql:{remaining:0,limit:5000,reset:1800000000},core:{remaining:4900,limit:5000,reset:1800000300}}});
  process.exit(0);
}
const isPull = endpoint === "repos/base-owner/base-repo/pulls/42";
let count = Number(fs.readFileSync(path.join(root,"count"),"utf8"));
if (isPull) fs.writeFileSync(path.join(root,"count"), String(++count));
const failureTarget = fixture.failureTarget || "pull";
const fail = failureTarget === "pull" ? isPull : failureTarget === "reread" ? isPull && count > 1 : failureTarget === "user" ? endpoint === "user" : failureTarget === "permission" ? endpoint.includes("/collaborators/") : failureTarget === "repository" ? endpoint === "repos/base-owner/base-repo" : endpoint.includes("/files?");
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
if (endpoint === "user") {
  process.stdout.write('HTTP/2.0 200 OK\\n\\n');
  out({login:"contributor"});
} else if (endpoint === "repos/base-owner/base-repo") {
  out({id:1,full_name:"base-owner/base-repo",html_url:repoURL,node_id:"R_base"});
} else if (isPull) {
  const record = {number:42,html_url:repoURL+"/pull/42",state:"open",draft:false,
    base:{sha:"${base}",ref:"main",repo:{id:1,node_id:"R_base",full_name:"base-owner/base-repo",html_url:repoURL}},
    head:{sha:"${head}",ref:"topic",repo:{id:2,name:"fork-repo",full_name:"fork-owner/fork-repo",html_url:"https://"+apiHost+"/fork-owner/fork-repo",owner:{login:"fork-owner"}}},
    user:{login:"contributor"},changed_files:fixture.changedFiles === undefined ? 101 : fixture.changedFiles};
  const stale = fixture.cacheUntilRevalidated && !args.includes("Cache-Control: max-age=0");
  const patch = (count === 1 || stale ? fixture.initialPatch : fixture.finalPatch) || {};
  out({...record,...patch,...(patch.base ? {base:{...record.base,...patch.base}} : {})});
} else if (endpoint.includes("/files?")) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) throw new Error("Files must be paginated");
  const count = fixture.changedFiles === undefined ? 101 : fixture.changedFiles || 0;
  const files = fixture.files === undefined ? Array.from({length:count},(_,i)=>({filename:"src/file-"+i+".ts",additions:1,deletions:0,status:i===count-1?"removed":"modified"})) : fixture.files;
  out(Array.isArray(files) ? [files.slice(0,100), ...(files.length > 100 ? [files.slice(100)] : [])] : [files]);
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
        PR_GH_WRITER_LOGIN: "untrusted-inherited-login",
        PR_GH_WRITER_CONTEXT: "untrusted-inherited-context",
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
    graphqlInputs: readFileSync(join(dir, "graphql-inputs"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { query: string; variables: Record<string, unknown> }),
    delays: readFileSync(join(dir, "sleeps"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number),
  };
}

describe("PR metadata through REST", () => {
  describe("core quota fallback", () => {
    const repository = {
      id: "R_base",
      databaseId: 1,
      nameWithOwner: "base-owner/base-repo",
      url: "https://github.com/base-owner/base-repo",
    };

    it.each(["observation", "repository only"])(
      "carries authoritative repository identity with one GraphQL PR read (%s)",
      (selection) => {
        const pullRequest = {
          id: "PR_42",
          number: 42,
          url: `${repository.url}/pull/42`,
          title: "Fixture",
          state: "OPEN",
          isDraft: false,
          author: { login: "contributor", __typename: "User" },
          baseRefName: "main",
          baseRefOid: base,
          headRefName: "topic",
          headRefOid: head,
          headRepository: {
            name: "fork-repo",
            nameWithOwner: "fork-owner/fork-repo",
            url: "https://github.com/fork-owner/fork-repo",
          },
          headRepositoryOwner: { login: "fork-owner", __typename: "User" },
          isCrossRepository: true,
        };
        const result = readPrMetadata(
          {
            ghRepo: "https://GITHUB.COM/Base-Owner/Base-Repo",
            coreQuotaAt: ["repos/Base-Owner/Base-Repo/pulls/42"],
            graphqlResponses: [{ data: { repository: { ...repository, pullRequest } } }],
          },
          selection === "observation"
            ? 'pr_observe 42; printf "%s\\n" "$PR_OBSERVATION"'
            : "pr_gh pr view 42 --json baseRepository",
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ baseRepository: repository });
        if (selection === "observation") {
          expect(JSON.parse(result.stdout)).toMatchObject({
            number: 42,
            headRefOid: head,
            headRefName: "topic",
            headRepository: pullRequest.headRepository,
          });
        }
        expect(result.calls).toEqual([
          [
            "api",
            "--hostname",
            "GITHUB.COM",
            "repos/Base-Owner/Base-Repo/pulls/42",
            "-H",
            "Cache-Control: max-age=0",
          ],
          [
            "api",
            "--hostname",
            "GITHUB.COM",
            "graphql",
            "--input",
            "-",
            "-H",
            "Cache-Control: max-age=0",
          ],
        ]);
        expect(result.graphqlInputs).toHaveLength(1);
        expect(result.graphqlInputs[0]?.query).toContain(
          "repository(owner:$owner,name:$name){id databaseId nameWithOwner url pullRequest(number:$number){",
        );
        expect(result.graphqlInputs[0]?.variables).toEqual({
          owner: "Base-Owner",
          name: "Base-Repo",
          number: 42,
        });
      },
    );

    it.each([
      { nameWithOwner: "other/repo" },
      { url: "https://other.invalid/base-owner/base-repo" },
      { id: null },
      { databaseId: 0 },
      { pullRequest: null },
    ])("rejects invalid carried repository or PR authority %j", (patch) => {
      const result = readPrMetadata(
        {
          ghRepo: repository.url,
          coreQuotaAt: ["repos/base-owner/base-repo/pulls/42"],
          graphqlResponses: [
            { data: { repository: { ...repository, pullRequest: { id: "PR_42" }, ...patch } } },
          ],
        },
        "pr_gh pr view 42 --json baseRepository",
      );
      expect(result.status, result.stderr).toBe(65);
      expect(result.stdout).toBe("");
      expect(result.calls).toHaveLength(2);
      expect(result.graphqlInputs).toHaveLength(1);
    });

    it("verifies the protected writer through GraphQL when REST quota is exhausted", () => {
      const result = readPrMetadata(
        {
          protectedGh: true,
          coreQuotaAt: ["user"],
          graphqlResponses: [{ data: { viewer: { login: "fixture-writer" } } }],
        },
        "pr_gh_writer_login github.com",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("fixture-writer");
      expect(result.calls.filter((call) => call.includes("graphql"))).toHaveLength(1);
    });

    it.each([false, true])(
      "resolves authoritative repository identity without a quota-blind HEAD (both budgets=%s)",
      (graphqlQuota) => {
        const result = readPrMetadata(
          {
            coreQuotaAt: ["browse", "repos/base-owner/base-repo"],
            graphqlResponses: [graphqlResponse(repository)],
            graphqlQuota,
          },
          "pr_gh_plain repo view --json id,nameWithOwner,url",
        );
        expect(result.status, result.stderr).toBe(graphqlQuota ? 75 : 0);
        if (!graphqlQuota) {
          expect(JSON.parse(result.stdout)).toEqual({
            id: "R_base",
            nameWithOwner: repository.nameWithOwner,
            url: repository.url,
          });
        }
        expect(result.calls.filter((call) => call.includes("graphql"))).toHaveLength(1);
        expect(result.calls).toContainEqual(["browse"]);
        expect(
          result.calls.filter((call) => call.includes("repos/base-owner/base-repo")),
        ).toHaveLength(1);
      },
    );

    it("preserves canonical repository identities for differently cased callers", () => {
      const result = readPrMetadata(
        {
          coreQuotaAt: ["repos/Base-Owner/Base-Repo"],
          graphqlResponses: [graphqlResponse(repository)],
        },
        "pr_gh_plain repo-authority Base-Owner/Base-Repo GitHub.com",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        id: 1,
        node_id: "R_base",
        full_name: repository.nameWithOwner,
        html_url: repository.url,
      });
    });

    it.each(["exact", "absent", "unavailable"])(
      "resolves %s author permission without accepting a fuzzy collaborator match",
      (mode) => {
        const page = (login: string, permission: string, hasNextPage: boolean) =>
          graphqlResponse({
            collaborators: {
              totalCount: 2,
              edges: [{ permission, node: { login } }],
              pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null },
            },
          });
        const result = readPrMetadata(
          {
            coreQuotaAt: ["repos/base-owner/base-repo/collaborators/human/permission"],
            graphqlResponses:
              mode === "unavailable"
                ? [
                    {
                      data: { repository: null },
                      errors: [{ message: "Unavailable collaborator contract" }],
                    },
                  ]
                : [
                    page("human-other", "ADMIN", true),
                    page(mode === "exact" ? "human" : "human-another", "WRITE", false),
                  ],
          },
          "pr_gh author-permission base-owner/base-repo github.com human",
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          permission: mode === "exact" ? "write" : mode === "absent" ? "none" : "unknown",
        });
      },
    );

    it.each(["complete", "partial", "duplicate", "errors"])(
      "reads %s GraphQL comment evidence after core exhaustion",
      (mode) => {
        const node = {
          id: "IC_1",
          databaseId: 12,
          body: "review",
          url: `${repository.url}/pull/42#issuecomment-12`,
          createdAt: "2026-09-20T00:00:00Z",
          updatedAt: "2026-09-20T00:00:00Z",
          author: { id: "BOT_1", databaseId: 274271284, login: "clawsweeper", __typename: "Bot" },
        };
        const page = (nodes: unknown[], hasNextPage: boolean) =>
          graphqlResponse({ pullRequest: { comments: connectionPage(nodes, hasNextPage) } });
        const result = readPrMetadata(
          {
            coreQuotaAt: ["repos/base-owner/base-repo/issues/42/comments?per_page=100"],
            graphqlResponses:
              mode === "errors"
                ? [{ ...page([node], false), errors: [{ message: "partial result" }] }]
                : [
                    page([node], mode !== "partial"),
                    page([{ ...node, databaseId: mode === "duplicate" ? 12 : 13 }], false),
                  ],
          },
          "pr_gh_plain issue-comments base-owner/base-repo github.com 42",
        );
        expect(result.status, result.stderr).toBe(mode === "complete" ? 0 : 65);
        if (mode === "complete") {
          const comments = JSON.parse(result.stdout).flat();
          expect(comments).toHaveLength(2);
          expect(comments[0]).toMatchObject({
            id: 12,
            body: "review",
            user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
            html_url: node.url,
          });
        } else {
          expect(result.stdout).toBe("");
        }
      },
    );

    it("preserves pinned author order and human attribution through GraphQL", () => {
      const first = "1".repeat(40);
      const second = "2".repeat(40);
      const result = readPrMetadata(
        {
          authorSources: [
            { oid: first, changesTree: true },
            { oid: second, changesTree: false },
          ],
          coreQuotaAt: [`repos/base-owner/base-repo/commits?sha=${second}&per_page=2`],
          graphqlResponses: [
            graphqlResponse({
              commit0: {
                oid: first,
                author: {
                  name: "Human",
                  email: "human@example.invalid",
                  user: { login: "human", __typename: "User" },
                },
              },
              commit1: {
                oid: second,
                author: { name: "Unlinked", email: "unlinked@example.invalid", user: null },
              },
            }),
          ],
        },
        'printf "%s\\n" "$FAKE_GH_FIXTURE" | jq .authorSources | pr_gh commit-authors base-owner/base-repo github.com',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        {
          name: "Human",
          email: "human@example.invalid",
          user: { login: "human", type: "User" },
          changesTree: true,
        },
        { name: "Unlinked", email: "unlinked@example.invalid", user: null, changesTree: false },
      ]);
    });

    it.each([false, true])(
      "returns complete PR file metadata through GraphQL (truncated=%s)",
      (truncated) => {
        const page = (path: string, hasNextPage: boolean) =>
          graphqlResponse({
            pullRequest: {
              files: connectionPage(
                [{ path, additions: 1, deletions: 0, changeType: "MODIFIED" }],
                hasNextPage,
              ),
            },
          });
        const result = readPrMetadata(
          {
            coreQuotaAt: ["repos/base-owner/base-repo/pulls/42"],
            graphqlResponses: [
              graphqlResponse({
                pullRequest: {
                  headRefOid: head,
                  author: null,
                  headRepository: null,
                  headRepositoryOwner: null,
                },
              }),
              page("src/a.ts", !truncated),
              page("src/b.ts", false),
            ],
          },
          "pr_gh pr view 42 --json headRefOid,author,headRepository,headRepositoryOwner,files",
        );
        expect(result.status, result.stderr).toBe(truncated ? 65 : 0);
        if (!truncated) {
          expect(JSON.parse(result.stdout)).toEqual({
            headRefOid: head,
            author: null,
            headRepository: null,
            headRepositoryOwner: null,
            files: ["src/a.ts", "src/b.ts"].map((path) => ({
              path,
              additions: 1,
              deletions: 0,
              changeType: "MODIFIED",
            })),
          });
        } else {
          expect(result.stdout).toBe("");
        }
        expect(result.calls.some((args) => args[0] === "pr")).toBe(false);
        expect(
          result.calls
            .filter((args) => args.includes("graphql"))
            .every((args) => args.includes("Cache-Control: max-age=0")),
        ).toBe(true);
      },
    );
  });

  it("accepts canonical repository casing when adopting an explicit qualified observation", () => {
    const result = readPrMetadata(
      { ghRepo: "https://GITHUB.COM/base-owner/base-repo" },
      'pr_observe 42; printf "%s\\n" "$PR_REPOSITORY_URL"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("https://github.com/base-owner/base-repo\n");
    expect(result.calls).toHaveLength(1);
  });

  it("authenticates nested worktree entries once without trusting inherited login state", () => {
    const result = readPrMetadata(
      {},
      'ensure_gh_api_auth; ensure_gh_api_auth; ensure_gh_api_auth; ensure_gh_api_auth; printf "%s\\n" "$PR_GH_WRITER_LOGIN"',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("contributor\n");
    expect(result.calls.filter((args) => args.includes("user"))).toHaveLength(1);
  });

  it("revalidates writer identity after explicit credential selection changes", () => {
    const result = readPrMetadata(
      {},
      "ensure_gh_api_auth; GH_TOKEN=synthetic-replacement ensure_gh_api_auth",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((args) => args.includes("user"))).toHaveLength(2);
  });

  it("does not retain a failed authentication probe", () => {
    const result = readPrMetadata(
      { failure: "quota", failureTarget: "user" },
      "ensure_gh_api_auth || true; ensure_gh_api_auth",
    );
    expect(result.status).not.toBe(0);
    expect(result.calls.filter((args) => args.includes("user"))).toHaveLength(2);
  });

  describe("pinned source authors", () => {
    const command =
      'printf "%s\\n" "$FAKE_GH_FIXTURE" | jq .authorSources | pr_gh commit-authors base-owner/base-repo github.enterprise.invalid';
    const sha = (index: number) => index.toString(16).padStart(40, "0");
    const source = (index: number) => ({ oid: sha(index), changesTree: index % 2 === 0 });
    const record = (index: number) => ({
      sha: sha(index),
      commit: { author: { name: `Author ${index}`, email: `author${index}@example.com` } },
      author: { login: `author${index}`, type: "User" },
    });
    const requests = (calls: string[][]) =>
      calls.map((args) => {
        expect(args.slice(0, 3)).toEqual(["api", "--hostname", "github.enterprise.invalid"]);
        const endpoint = args[3];
        if (endpoint === undefined) {
          throw new Error("Expected a commit-author API endpoint");
        }
        const query = new URL(endpoint, "https://github.enterprise.invalid/").searchParams;
        return { sha: query.get("sha"), limit: Number(query.get("per_page")) };
      });

    it("does not read GitHub for an empty source selection", () => {
      const result = readPrMetadata({ authorSources: [] }, command);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(result.calls).toEqual([]);
    });

    it("resolves 101 pinned authors in two requests and retains original source order", () => {
      const sources = Array.from({ length: 101 }, (_, index) => source(index + 1));
      const records = Array.from({ length: 101 }, (_, index) => record(index + 1));
      const result = readPrMetadata(
        { authorSources: sources, authorPages: [records.slice(1).toReversed(), [records[0]]] },
        command,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        records.map((commit, index) => ({
          name: commit.commit.author.name,
          email: commit.commit.author.email,
          user: commit.author,
          changesTree: source(index + 1).changesTree,
        })),
      );
      expect(requests(result.calls)).toEqual([
        { sha: sha(101), limit: 100 },
        { sha: sha(1), limit: 1 },
      ]);
    });

    it("ignores unrelated ancestry and uses singleton requests for every remaining author", () => {
      const result = readPrMetadata(
        {
          authorSources: [source(1), source(2), source(3), source(4)],
          authorPages: [
            [record(4), record(99), record(98), record(97)],
            [record(3)],
            [record(2)],
            [record(1)],
          ],
        },
        command,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).map((author: { name: string }) => author.name)).toEqual([
        "Author 1",
        "Author 2",
        "Author 3",
        "Author 4",
      ]);
      expect(requests(result.calls)).toEqual([
        { sha: sha(4), limit: 4 },
        { sha: sha(3), limit: 1 },
        { sha: sha(2), limit: 1 },
        { sha: sha(1), limit: 1 },
      ]);
    });

    it.each([
      null,
      {},
      [source(1), source(1)],
      [{ oid: "main", changesTree: true }],
      [{ oid: sha(1) }],
    ])("rejects invalid source selections before reading GitHub: %j", (authorSources) => {
      const result = readPrMetadata({ authorSources }, command);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe("");
      expect(result.calls).toEqual([]);
    });

    it.each([
      null,
      {},
      [],
      [record(2)],
      [record(1), record(1)],
      [{ ...record(1), sha: "main" }],
      [{ ...record(1), author: undefined }],
      [{ ...record(1), author: { login: "bot", type: null } }],
      [{ ...record(1), commit: { author: { name: null, email: "author1@example.com" } } }],
    ])("rejects malformed or unbound author evidence without retrying: %j", (page) => {
      const result = readPrMetadata({ authorSources: [source(1)], authorPages: [page] }, command);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe("");
      expect(result.calls).toHaveLength(1);
    });

    it("rejects duplicate authors even when the batch has the requested size and tip", () => {
      const result = readPrMetadata(
        {
          authorSources: [source(1), source(2)],
          authorPages: [[record(2), record(2)]],
        },
        command,
      );
      expect(result.status).toBe(65);
      expect(result.stdout).toBe("");
      expect(result.calls).toHaveLength(1);
    });
  });

  it.each([
    {
      name: "qualified repo URL",
      ghRepo: "base-owner/base-repo",
      command:
        "pr_gh_plain repo view --json url --repo https://github.enterprise.invalid/base-owner/base-repo",
      failureTarget: "repository",
      host: "github.enterprise.invalid",
    },
    {
      name: "qualified GH_REPO",
      ghRepo: "github.enterprise.invalid/base-owner/base-repo",
      command: "pr_gh_plain repo view --json url",
      failureTarget: "repository",
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
        id: 1,
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
    expect(result.calls.filter((args) => args[0] === "browse")).toEqual([["browse"], ["browse"]]);
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
  it.each(["environment", "explicit", "explicit-git-suffix"])(
    "preserves the %s repository override before gh's default",
    (mode) => {
      const explicit =
        mode === "environment"
          ? ""
          : ` --repo=https://github.com/base-owner/base-repo${mode === "explicit-git-suffix" ? ".git" : ""}`;
      const result = readPrMetadata(
        {
          ghRepo: explicit ? "ignored/repo" : "base-owner/base-repo",
          defaultRepoURL: "https://github.com/ignored/default",
        },
        `pr_gh pr view 42 --json number,headRefOid${explicit}; pr_gh_plain pr edit 42 --add-assignee contributor${explicit}`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ number: 42, headRefOid: head });
      expect(result.calls.filter((args) => args[0] === "browse")).toEqual(
        explicit ? [] : [["browse"], ["browse"]],
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
        selection === "--repo" ? ["browse", "--repo", "base-owner/base-repo"] : ["browse"],
      );
    },
  );
  it.each(["forbidden", "quota"] as const)(
    "reports %s collaborator lookup failures with the existing preparation policy",
    (failure) => {
      const result = readPrMetadata(
        { failure, failureTarget: "permission" },
        "source scripts/pr-lib/prepare-core.sh; resolve_pr_author_access_at_prepare contributor base-owner/base-repo github.com",
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
  it("collects complete paginated files without requesting unrelated checks or GraphQL", () => {
    const result = readPrMetadata();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.attempts).toBe(2);
    expect(result.calls.filter((args) => args[0] === "api")).toHaveLength(3);
    expect(result.calls.some((args) => args.includes("repos/base-owner/base-repo"))).toBe(false);
    expect(
      result.calls.every(
        (args) => (args[0] === "api" && !args.includes("graphql")) || args[0] === "browse",
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
    expect(
      result.calls.some((args) =>
        args.some((arg) => arg.includes("/check-runs?") || arg.includes("/status?")),
      ),
    ).toBe(false);
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

  it.each(["REST", "GraphQL"])(
    "revalidates both %s observations and rejects files collected while the PR head moves",
    (transport) => {
      const metadata = {
        number: 42,
        title: "Fixture",
        state: "OPEN",
        isDraft: false,
        author: null,
        baseRefName: "main",
        baseRefOid: base,
        headRefName: "topic",
        headRefOid: head,
        isCrossRepository: false,
        headRepository: null,
        headRepositoryOwner: null,
        url: "https://github.com/base-owner/base-repo/pull/42",
        body: "",
        changedFiles: 0,
        additions: 0,
        deletions: 0,
      };
      const response = (pullRequest: unknown) =>
        graphqlResponse({
          id: "R_base",
          databaseId: 1,
          nameWithOwner: "base-owner/base-repo",
          url: "https://github.com/base-owner/base-repo",
          pullRequest,
        });
      const emptyPage = { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } };
      const result = readPrMetadata({
        cacheUntilRevalidated: true,
        finalPatch: { head: { sha: "b".repeat(40), ref: "topic" } },
        ...(transport === "GraphQL"
          ? {
              coreQuotaAt: ["repos/base-owner/base-repo/pulls/42"],
              graphqlResponses: [
                response(metadata),
                response({ labels: emptyPage }),
                response({ assignees: emptyPage }),
                response({ files: emptyPage }),
                response({ ...metadata, headRefOid: "b".repeat(40) }),
              ],
            }
          : {}),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("PR head changed while collecting file metadata");
    },
  );

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
    { command: "ensure_gh_api_auth", failureTarget: "user", resource: "core", exitCode: 1 },
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
