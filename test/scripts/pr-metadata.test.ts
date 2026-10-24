import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const head = "a".repeat(40);
const base = "c".repeat(40);
const repository = {
  id: "R_base",
  databaseId: 1,
  nameWithOwner: "base-owner/base-repo",
  url: "https://github.com/base-owner/base-repo",
};
const repoName = repository.nameWithOwner;
const enterprise = "github.enterprise.invalid";
const repoEndpoint = (suffix = "") => `repos/${repoName}${suffix}`;
const repoCommand = "pr_gh_plain repo view --json url";
const assignContributor = "pr_gh_plain pr edit 42 --add-assignee contributor";
const restRepository = {
  id: repository.databaseId,
  full_name: repository.nameWithOwner,
  html_url: repository.url,
  node_id: repository.id,
};
const authorCommand = (host = "github.com") =>
  `printf "%s\\n" "$FAKE_GH_FIXTURE" | jq .authorSources | pr_gh commit-authors ${repoName} ${host}`;
const quotaDetail =
  "graphql 0/5000 reset=2027-01-15T08:00:00Z core 4900/5000 reset=2027-01-15T08:05:00Z";

function revalidatedCall(endpoint: string, host = "github.com", ...flags: string[]) {
  return ["api", "--hostname", host, endpoint, ...flags, "-H", "Cache-Control: max-age=0"];
}

function readLines(file: string) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function readJsonLines<T>(file: string): T[] {
  return readLines(file).map((line) => JSON.parse(line) as T);
}

type MetadataResult = ReturnType<typeof readPrMetadata>;
const callsTo = (result: MetadataResult, target: string) =>
  result.calls.filter((args) => args.includes(target));

function expectPayload(result: MetadataResult, bytes: Buffer, exists = false) {
  expect(result.payloads).toEqual([
    { path: expect.any(String), base64: bytes.toString("base64"), exists },
  ]);
}

function expectSupplementalQuota(result: MetadataResult) {
  expect(result.stderr).toContain("resource=core");
  expect(result.stderr).toContain(quotaDetail);
  expect(result.stderr).toContain(
    "Supplemental quota probe (remaining/limit; not the failing response)",
  );
  expect(result.stderr).not.toContain("Wait until");
  expect(result.stderr).not.toContain("secret-response-must-not-escape");
  expect(callsTo(result, "rate_limit")).toHaveLength(1);
}

function restFile(overrides: Record<string, unknown> = {}) {
  return { filename: "x", status: "modified", additions: 0, deletions: 0, ...overrides };
}

function graphqlFile(path: string, changeType = "MODIFIED") {
  return { path, additions: 1, deletions: 0, changeType };
}

function graphqlResponse(record: unknown) {
  return { data: { repository: record } };
}

function pullResponse(pullRequest: unknown) {
  return graphqlResponse({ ...repository, pullRequest });
}

function pullFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "PR_42",
    number: 42,
    url: `${repository.url}/pull/42`,
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
    body: "",
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

function connectionPage(nodes: unknown[], hasNextPage: boolean, totalCount = 2) {
  return {
    nodes,
    totalCount,
    pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null },
  };
}

function pullPage(field: string, nodes: unknown[], hasNextPage: boolean, totalCount = 2) {
  return pullResponse({ [field]: connectionPage(nodes, hasNextPage, totalCount) });
}

function fallback(target: string, responses: unknown[], command: string, fixture: Fixture = {}) {
  return readPrMetadata(
    { coreQuotaAt: [target], graphqlResponses: responses, ...fixture },
    command,
  );
}

function expectResult(
  result: MetadataResult,
  status: number,
  fields: Partial<MetadataResult> = {},
) {
  expect(result, result.stderr).toMatchObject({ status, ...fields });
}

function expectJson(result: MetadataResult, expected: unknown, status = 0) {
  expectResult(result, status);
  expect(JSON.parse(result.stdout)).toEqual(expected);
}

function expectCall(result: MetadataResult, ...args: string[]) {
  expect(result.calls).toContainEqual(args);
}

function expectAssignedRepository(result: MetadataResult, url = repository.url) {
  expectCall(result, "pr", "edit", "42", "--add-assignee", "contributor", "--repo", url);
}

const pullEndpoint = repoEndpoint("/pulls/42");
const viewPull = (fields: string) => `pr_gh pr view 42 --json ${fields}`;

type Fixture = {
  changedFiles?: number | null;
  files?: unknown;
  initialPatch?: Record<string, unknown>;
  finalPatch?: Record<string, unknown>;
  failure?: "empty" | "exit" | "non-json" | "null" | "quota" | "forbidden";
  failureCount?: number;
  failureTarget?: "pull" | "reread" | "files" | "user" | "permission" | "checks" | "repository";
  cacheUntilRevalidated?: boolean;
  notify?: boolean;
  ghRepo?: string;
  configuredHost?: string;
  defaultRepoURL?: string;
  probeGit?: boolean;
  protectedGh?: boolean;
  cleanupFailure?: boolean;
  commandFailure?: { stdout: string; stderr: string };
  authorSources?: unknown;
  authorPages?: unknown[];
  coreQuotaAt?: string[];
  graphqlResponses?: unknown[];
  graphqlQuota?: boolean;
};

function readPrMetadata(fixture: Fixture = {}, command = "pr_meta_json 42") {
  const dir = tempDirs.make("openclaw-pr-metadata-");
  const script = (file: string, source: string) =>
    writeFileSync(join(dir, file), source, { mode: 0o755 });
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
  if (/openclaw-pr-gh-(git|input)-/.test(String(path))) {
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
    script(
      "selected-git",
      "#!/bin/sh\ncase \"$*\" in\n  --version) printf 'selected fixture Git\\n' ;;\n  *) exit 79 ;;\nesac\n",
    );
    script("git", "#!/bin/sh\necho 'poisoned PATH Git' >&2\nexit 79\n");
  }
  for (const file of ["trace", "graphql-inputs", "payloads", "sleeps", "notify"]) {
    writeFileSync(join(dir, file), "");
  }
  for (const file of ["count", "graphql-count"]) {
    writeFileSync(join(dir, file), "0");
  }
  script(
    "gh",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = __dirname;
const fixture = JSON.parse(process.env.FAKE_GH_FIXTURE);
fs.appendFileSync(path.join(root, "trace"), JSON.stringify(args) + "\\n");
const inputPath = args.find(arg => arg.startsWith("--input="))?.slice("--input=".length)
  ?? (args.includes("--input") ? args[args.indexOf("--input") + 1] : undefined);
let inputBytes;
if (args[0] === "api" && inputPath !== undefined) {
  if (inputPath === "-" || !path.isAbsolute(inputPath)) throw new Error("API payload must use an absolute file, not stdin");
  if (!fs.statSync(inputPath).isFile()) throw new Error("API payload file is unavailable");
  if ((fs.statSync(inputPath).mode & 0o777) !== 0o600 || (fs.statSync(path.dirname(inputPath)).mode & 0o777) !== 0o700) throw new Error("API payload must be private");
  if (fs.readFileSync(0).length) throw new Error("API payload leaked to child stdin");
  inputBytes = fs.readFileSync(inputPath);
  fs.appendFileSync(path.join(root, "payloads"), JSON.stringify({path:inputPath,base64:inputBytes.toString("base64")}) + "\\n");
}
if (args.includes("rate_limit") && fs.readFileSync(0).length) throw new Error("Payload leaked to quota probe");
if (fixture.commandFailure) {
  process.stdout.write(fixture.commandFailure.stdout);
  process.stderr.write(fixture.commandFailure.stderr);
  process.exit(7);
}
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (value, status = 0) => { out(value); process.exit(status); };
const quotaFailure = (message) => { console.error(message); process.exit(1); };
const defaultHost = process.env.GH_HOST || fixture.configuredHost || "github.com";
const qualifyRepository = (repository) => {
  repository = repository.replace(/\\.git$/, "");
  return repository.startsWith("https://") ? repository
    : "https://" + (repository.split("/").length === 3 ? repository : defaultHost + "/" + repository);
};
const operation = args[0] === "browse" ? "browse" : args.find((arg) => arg.startsWith("repos/") || arg === "user");
if (fixture.coreQuotaAt?.includes(operation) && (operation !== "browse" || args.includes("--no-browser"))) {
  if (operation === "browse") {
    quotaFailure("HTTP 403: Forbidden (https://api.github.com/repos/base-owner/base-repo)");
  }
  console.log('HTTP/2 403 Forbidden\\nX-RateLimit-Resource: core\\nX-RateLimit-Remaining: 0\\n\\n'+JSON.stringify({message:"API rate limit exceeded"}));
  quotaFailure("gh: API rate limit exceeded");
}
if (args[0] === "pr" && args[1] === "view") {
  throw new Error("Top-level pr view can spend REST quota again; use the GraphQL endpoint");
}
if (args[0] === "api" && args.includes("graphql")) {
  if (inputBytes) fs.appendFileSync(path.join(root,"graphql-inputs"),JSON.stringify(JSON.parse(inputBytes.toString("utf8")))+"\\n");
  if (fixture.graphqlQuota) quotaFailure("gh: API rate limit exceeded");
  const count = Number(fs.readFileSync(path.join(root,"graphql-count"),"utf8"));
  fs.writeFileSync(path.join(root,"graphql-count"),String(count+1));
  if (!fixture.graphqlResponses || count >= fixture.graphqlResponses.length) throw new Error("Unexpected GraphQL request");
  if (args.includes("--include")) process.stdout.write("HTTP/2 200 OK\\n\\n");
  let response = fixture.graphqlResponses[count];
  if (fixture.cacheUntilRevalidated && !args.includes("Cache-Control: max-age=0") && response.data?.repository?.pullRequest?.headRefOid) {
    response = fixture.graphqlResponses[0];
  }
  reply(response);
}
if (args[0] === "browse") {
  if (!args.includes("--no-browser") && !process.env.GH_BROWSER) {
    throw new Error("Repository discovery must not open the configured browser");
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
  if (fixture.failure === "quota" && fixture.failureTarget === "checks") quotaFailure("HTTP 403: API rate limit exceeded");
  reply([{name:"RATE_LIMIT",bucket:"pending",state:"PENDING"}], 8);
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
  reply(fixture.authorPages[count]);
}
if (endpoint === "rate_limit") {
  reply({resources:{graphql:{remaining:0,limit:5000,reset:1800000000},core:{remaining:4900,limit:5000,reset:1800000300}}});
}
const isPull = endpoint === "repos/base-owner/base-repo/pulls/42";
let count = Number(fs.readFileSync(path.join(root,"count"),"utf8"));
if (isPull) fs.writeFileSync(path.join(root,"count"), String(++count));
const failureTarget = fixture.failureTarget || "pull";
const fail = failureTarget === "pull" ? isPull : failureTarget === "reread" ? isPull && count > 1 : failureTarget === "user" ? endpoint === "user" : failureTarget === "permission" ? endpoint.includes("/collaborators/") : failureTarget === "repository" ? endpoint === "repos/base-owner/base-repo" : endpoint.includes("/files?");
if (fixture.failure && fail && (fixture.failureCount === undefined || count <= fixture.failureCount)) {
  if (["forbidden", "quota"].includes(fixture.failure)) {
    quotaFailure("HTTP 403: " + (fixture.failure === "forbidden" ? "Resource not accessible by integration" : "API rate limit exceeded") + "; secret-response-must-not-escape");
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
  const selectedGh = join(dir, "selected-gh");
  if (fixture.protectedGh) {
    copyFileSync(gh, selectedGh);
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
        // This unsupervised child owns neither the parent's snapshot nor its FD3.
        OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: undefined,
        OPENCLAW_PR_LOCK_NOTIFY_FD: undefined,
        FAKE_GH_FIXTURE: JSON.stringify(fixture),
        PR_GH_WRITER_LOGIN: "untrusted-inherited-login",
        PR_GH_WRITER_CONTEXT: "untrusted-inherited-context",
        FAKE_GH_NOTIFY: join(dir, "notify"),
        GH_REPO: fixture.ghRepo ?? "base-owner/base-repo",
        GH_HOST: undefined,
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
    payloads: readJsonLines<{ path: string; base64: string }>(join(dir, "payloads")).map(
      (payload) => Object.assign(payload, { exists: existsSync(dirname(payload.path)) }),
    ),
    calls: readJsonLines<string[]>(trace),
    graphqlInputs: readJsonLines<{ query: string; variables: Record<string, unknown> }>(
      join(dir, "graphql-inputs"),
    ),
    delays: readLines(join(dir, "sleeps")).map(Number),
  };
}

it.each([
  ["stdout", "  provider response\r\n\n", ""],
  ["stderr", "", " \tprovider diagnostic\r\n\n"],
  ["both", " provider response\r\n", " \tdiagnostic\n\n"],
  ["neither", "", ""],
])("preserves failed CLI %s bytes", (_stream, stdout, stderr) => {
  const result = readPrMetadata(
    { commandFailure: { stdout, stderr } },
    "pr_gh_plain api repos/base-owner/base-repo",
  );
  expectResult(result, 7, { stdout });
  if (stdout || stderr) {
    expect(result.stderr).toBe(stderr);
  } else {
    expect(result.stderr).toContain("Command failed:");
  }
});

it.each(["inherited", "buffer", "string", "empty", "ignored"] as const)(
  "preserves and cleans private %s API input",
  (source) => {
    const payload = Buffer.concat([
      Buffer.from('{\r\n  "body": "café 🦊"\r\n}\r\n'),
      source === "buffer" ? Buffer.from([0, 255]) : Buffer.alloc(0),
    ]);
    const expected = source === "empty" || source === "ignored" ? Buffer.alloc(0) : payload;
    const input =
      source === "string" || source === "empty"
        ? JSON.stringify(expected.toString())
        : `Buffer.from("${expected.toString("base64")}", "base64")`;
    const stdinPath = join(tempDirs.make("openclaw-pr-input-"), "stdin");
    writeFileSync(stdinPath, payload);
    const inputArgs = source === "string" ? '"--input=-"' : '"--input", "-"';
    const command =
      source === "inherited"
        ? "pr_gh_plain api repos/base-owner/base-repo --input -"
        : `node --input-type=module -e 'import { execPrGh } from "./scripts/pr-lib/github.mjs"; process.stdout.write(execPrGh(["api", "repos/base-owner/base-repo", ${inputArgs}], {encoding:"utf8", ${source === "ignored" ? "" : `input:${input},`} stdio:["${source === "ignored" ? "ignore" : "inherit"}","pipe","pipe"]}, "plain"))'`;
    const result = readPrMetadata({}, `${command} < '${stdinPath.replaceAll("'", "'\\''")}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ full_name: "base-owner/base-repo" });
    expectPayload(result, expected);
  },
);

it.each(["observation", "repository only"])(
  "carries GraphQL repository authority: %s",
  (selection) => {
    const pullRequest = pullFixture({
      author: { login: "contributor", __typename: "User" },
      headRepository: {
        name: "fork-repo",
        nameWithOwner: "fork-owner/fork-repo",
        url: "https://github.com/fork-owner/fork-repo",
      },
      headRepositoryOwner: { login: "fork-owner", __typename: "User" },
      isCrossRepository: true,
    });
    const result = fallback(
      "repos/Base-Owner/Base-Repo/pulls/42",
      [pullResponse(pullRequest)],
      selection === "observation"
        ? 'pr_observe 42; printf "%s\\n" "$PR_OBSERVATION"'
        : viewPull("baseRepository"),
      { ghRepo: "https://GITHUB.COM/Base-Owner/Base-Repo" },
    );
    expectResult(result, 0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      baseRepository: repository,
      ...(selection === "observation"
        ? {
            number: 42,
            headRefOid: head,
            headRefName: "topic",
            headRepository: pullRequest.headRepository,
          }
        : {}),
    });
    expect(result.calls).toEqual([
      revalidatedCall("repos/Base-Owner/Base-Repo/pulls/42", "GITHUB.COM"),
      revalidatedCall("graphql", "GITHUB.COM", "--input", result.payloads[0]!.path),
    ]);
    expect(result.graphqlInputs).toEqual([
      {
        query: expect.stringContaining(
          "repository(owner:$owner,name:$name){id databaseId nameWithOwner url pullRequest(number:$number){",
        ),
        variables: { owner: "Base-Owner", name: "Base-Repo", number: 42 },
      },
    ]);
  },
);

it.each([
  { nameWithOwner: "other/repo" },
  { url: "https://other.invalid/base-owner/base-repo" },
  { id: null },
  { databaseId: 0 },
  { pullRequest: null },
])("rejects invalid GraphQL authority %j", (patch) => {
  const result = fallback(
    pullEndpoint,
    [graphqlResponse({ ...repository, pullRequest: { id: "PR_42" }, ...patch })],
    viewPull("baseRepository"),
    { ghRepo: repository.url },
  );
  expectResult(result, 65, { stdout: "" });
  expect(result.calls).toHaveLength(2);
  expect(result.graphqlInputs).toHaveLength(1);
});

it("verifies the GraphQL fallback writer", () => {
  const result = fallback(
    "user",
    [{ data: { viewer: { login: "fixture-writer" } } }],
    "pr_gh_writer_login github.com",
    { protectedGh: true },
  );
  expectResult(result, 0, { stdout: "fixture-writer\n" });
  expect(callsTo(result, "graphql")).toHaveLength(1);
});

it.each([false, true])("resolves quota-exhausted repo (GraphQL exhausted=%s)", (graphqlQuota) => {
  const result = readPrMetadata(
    {
      coreQuotaAt: ["browse", "repos/base-owner/base-repo"],
      graphqlResponses: [graphqlResponse(repository)],
      graphqlQuota,
    },
    "pr_gh_plain repo view --json id,nameWithOwner,url",
  );
  expectResult(result, graphqlQuota ? 75 : 0);
  if (!graphqlQuota) {
    expectJson(result, { id: "R_base", nameWithOwner: repoName, url: repository.url });
  }
  expect(callsTo(result, "graphql")).toHaveLength(1);
  expect(result.calls).toContainEqual(["browse"]);
  expect(callsTo(result, repoEndpoint())).toHaveLength(1);
});

it.each(["exact", "absent", "unavailable"])("requires exact %s collaborator authority", (mode) => {
  const page = (login: string, permission: string, hasNextPage: boolean) =>
    graphqlResponse({
      collaborators: {
        ...connectionPage([], hasNextPage),
        edges: [{ permission, node: { login } }],
      },
    });
  const result = fallback(
    repoEndpoint("/collaborators/human/permission"),
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
    "pr_gh author-permission base-owner/base-repo github.com human",
  );
  expectJson(result, {
    permission: mode === "exact" ? "write" : mode === "absent" ? "none" : "unknown",
  });
});

it.each(["complete", "duplicate", "errors"])("requires %s GraphQL comment evidence", (mode) => {
  const node = {
    databaseId: 12,
    body: "review",
    url: `${repository.url}/pull/42#issuecomment-12`,
    author: { databaseId: 274271284, login: "clawsweeper", __typename: "Bot" },
  };
  const page = (nodes: unknown[], hasNextPage: boolean) => pullPage("comments", nodes, hasNextPage);
  const result = fallback(
    repoEndpoint("/issues/42/comments?per_page=100"),
    mode === "errors"
      ? [{ ...page([node], false), errors: [{ message: "partial result" }] }]
      : [
          page([node], true),
          page([{ ...node, databaseId: mode === "duplicate" ? 12 : 13 }], false),
        ],
    "pr_gh_plain issue-comments base-owner/base-repo github.com 42",
  );
  expectResult(result, mode === "complete" ? 0 : 65);
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
});

it("pins GraphQL author order and human attribution", () => {
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  const human = { name: "Human", email: "human@example.invalid" };
  const unlinked = { name: "Unlinked", email: "unlinked@example.invalid", user: null };
  const result = fallback(
    repoEndpoint(`/commits?sha=${second}&per_page=2`),
    [
      graphqlResponse({
        commit0: {
          oid: first,
          author: { ...human, user: { login: "human", __typename: "User" } },
        },
        commit1: { oid: second, author: unlinked },
      }),
    ],
    authorCommand(),
    {
      authorSources: [
        { oid: first, changesTree: true },
        { oid: second, changesTree: false },
      ],
    },
  );
  expectJson(result, [
    { ...human, user: { login: "human", type: "User" }, changesTree: true },
    { ...unlinked, changesTree: false },
  ]);
});

it.each([false, true])("requires complete GraphQL files (truncated=%s)", (truncated) => {
  const page = (path: string, hasNextPage: boolean) =>
    pullPage("files", [graphqlFile(path)], hasNextPage);
  const nullableIdentity = {
    headRefOid: head,
    author: null,
    headRepository: null,
    headRepositoryOwner: null,
  };
  const result = fallback(
    pullEndpoint,
    [pullResponse(nullableIdentity), page("src/a.ts", !truncated), page("src/b.ts", false)],
    viewPull("headRefOid,author,headRepository,headRepositoryOwner,files"),
  );
  expectResult(result, truncated ? 65 : 0);
  if (!truncated) {
    expect(JSON.parse(result.stdout)).toEqual({
      ...nullableIdentity,
      files: ["src/a.ts", "src/b.ts"].map((path) => graphqlFile(path)),
    });
  } else {
    expect(result.stdout).toBe("");
  }
  expect(
    callsTo(result, "graphql").every((args) => args.includes("Cache-Control: max-age=0")),
  ).toBe(true);
});
it.each([
  ["cached", "ensure_gh_api_auth; ensure_gh_api_auth; ensure_gh_api_auth; ensure_gh_api_auth", 1],
  ["credential change", "ensure_gh_api_auth; GH_TOKEN=synthetic-replacement ensure_gh_api_auth", 2],
  ["failed", "ensure_gh_api_auth || true; ensure_gh_api_auth", 2],
] as const)("reuses only valid writer auth: %s", (mode, command, probes) => {
  const result = readPrMetadata(
    mode === "failed" ? { failure: "quota", failureTarget: "user" } : {},
    `${command}; printf "%s\\n" "$PR_GH_WRITER_LOGIN"`,
  );
  if (mode === "failed") {
    expect(result.status).not.toBe(0);
  } else {
    expectResult(result, 0, { stdout: "contributor\n" });
  }
  expect(callsTo(result, "user")).toHaveLength(probes);
});

const authorRead = authorCommand(enterprise);
const sha = (index: number) => index.toString(16).padStart(40, "0");
const source = (index: number) => ({ oid: sha(index), changesTree: index % 2 === 0 });
const record = (index: number) => ({
  sha: sha(index),
  commit: { author: { name: `Author ${index}`, email: `author${index}@example.com` } },
  author: { login: `author${index}`, type: "User" },
});
const requests = (calls: string[][]) =>
  calls.map((args) => {
    expect(args.slice(0, 3)).toEqual(["api", "--hostname", enterprise]);
    const query = new URL(args[3] ?? "", `https://${enterprise}/`).searchParams;
    return { sha: query.get("sha"), limit: Number(query.get("per_page")) };
  });

it.each([0, 101, 4])("bounds reads for %i ordered authors", (count) => {
  const pages =
    count === 101
      ? [Array.from({ length: 100 }, (_, i) => 101 - i), [1]]
      : count === 4
        ? [[4, 99, 98, 97], [3], [2], [1]]
        : [];
  const requested = count === 101 ? [101, 1] : count === 4 ? [4, 3, 2, 1] : [];
  const sources = Array.from({ length: count }, (_, index) => source(index + 1));
  const result = readPrMetadata(
    { authorSources: sources, authorPages: pages.map((page) => page.map(record)) },
    authorRead,
  );
  expectJson(
    result,
    sources.map((entry, index) => ({
      name: `Author ${index + 1}`,
      email: `author${index + 1}@example.com`,
      user: { login: `author${index + 1}`, type: "User" },
      changesTree: entry.changesTree,
    })),
  );
  expect(requests(result.calls)).toEqual(
    requested.map((index, page) => ({
      sha: sha(index),
      limit: page ? 1 : Math.min(count, 100),
    })),
  );
});

it.each([
  { fixture: { authorSources: null }, calls: 0 },
  { fixture: { authorSources: [source(1), source(1)] }, calls: 0 },
  { fixture: { authorSources: [{ oid: "main", changesTree: true }] }, calls: 0 },
  { fixture: { authorSources: [{ oid: sha(1) }] }, calls: 0 },
  ...[
    null,
    [],
    [record(2)],
    [record(1), record(1)],
    [{ ...record(1), sha: "main" }],
    [{ ...record(1), author: undefined }],
    [{ ...record(1), author: { login: "bot", type: null } }],
    [{ ...record(1), commit: { author: { name: null, email: "author1@example.com" } } }],
  ].map((page) => ({
    fixture: { authorSources: [source(1)], authorPages: [page] },
    calls: 1,
  })),
  {
    fixture: { authorSources: [source(1), source(2)], authorPages: [[record(2), record(2)]] },
    calls: 1,
  },
])("rejects invalid authors in $calls reads: $fixture", ({ fixture, calls }) => {
  const result = readPrMetadata(fixture, authorRead);
  expectResult(result, 65, { stdout: "" });
  expect(result.calls).toHaveLength(calls);
});
it.each([
  [
    "qualified repo URL",
    "repository",
    repoName,
    `${repoCommand} --repo https://${enterprise}/${repoName}`,
  ],
  ["qualified GH_REPO", "repository", `${enterprise}/${repoName}`, repoCommand],
  [
    "qualified short repo flag",
    "checks",
    repoName,
    `pr_gh_plain pr checks 42 --required --json name,bucket,state -R ${enterprise}/${repoName}`,
  ],
  ["raw API default", "pull", `${enterprise}/${repoName}`, `pr_gh_plain api ${pullEndpoint}`],
] as const)("probes only the failing host: %s", (_name, failureTarget, ghRepo, command) => {
  const host = failureTarget === "pull" ? "" : "github.enterprise.invalid";
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
  expectResult(result, 75, { stdout: "", delays: [] });
  expect(callsTo(result, "rate_limit")).toEqual([
    ["api", ...(host ? ["--hostname", host] : []), "rate_limit"],
  ]);
});
it.each([false, true])("preserves cleanup-failed results: %s", (failed) => {
  const result = readPrMetadata(
    {
      probeGit: true,
      cleanupFailure: true,
      failure: failed ? "exit" : undefined,
      failureTarget: "repository",
    },
    'printf "payload" | pr_gh_plain api repos/base-owner/base-repo --input - 2>&1',
  );
  expectResult(result, failed ? 7 : 0, {
    stderr: "",
    stdout: failed
      ? "HTTP 503: No server is currently available\n"
      : JSON.stringify(restRepository) + "\n",
  });
  expectPayload(result, Buffer.from("payload"), true);
});
it.each([
  { selection: "GH_REPO", enterpriseHost: enterprise },
  { selection: "--repo", enterpriseHost: `${enterprise}:8443` },
])("resolves $selection at $enterpriseHost without GH_HOST", ({ selection, enterpriseHost }) => {
  const repoURL = `https://${enterpriseHost}/base-owner/base-repo`;
  const explicit = selection === "--repo" ? " --repo base-owner/base-repo" : "";
  const result = readPrMetadata(
    {
      ghRepo: selection === "GH_REPO" ? "base-owner/base-repo" : "",
      configuredHost: enterpriseHost,
      defaultRepoURL: repoURL,
      protectedGh: true,
    },
    `${repoCommand}${explicit}; ${assignContributor}`,
  );
  expectJson(result, { url: repoURL });
  expectCall(result, ...revalidatedCall(repoEndpoint(), enterpriseHost));
  expectAssignedRepository(result, repoURL);
  expect(result.calls).toContainEqual(
    selection === "--repo" ? ["browse", "--repo", "base-owner/base-repo"] : ["browse"],
  );
});
it.each(["forbidden", "quota"] as const)("applies %s collaborator failure policy", (failure) => {
  const result = readPrMetadata(
    { failure, failureTarget: "permission" },
    "source scripts/pr-lib/prepare-core.sh; resolve_pr_author_access_at_prepare contributor base-owner/base-repo github.com",
  );
  expectResult(result, failure === "forbidden" ? 0 : 1, {
    stdout: failure === "forbidden" ? "unknown\n" : "",
  });
  expectSupplementalQuota(result);
});
it.each([undefined, 0, 1.5])("blocks CI dispatch without repo ID: %s", (id) => {
  const result = readPrMetadata(
    {
      initialPatch: {
        base: { sha: base, ref: "main", repo: { id } },
        head: { sha: head, ref: "topic", repo: { id } },
      },
    },
    "source scripts/pr-lib/gates.sh; ci_dispatch 42",
  );
  expectResult(result, 1, { stdout: "" });
  expect(result.stderr).toContain("missing repository identity for workflow dispatch");
  expect(result.calls.some((args) => args[0] === "workflow")).toBe(false);
});
it("preserves pending checks without false quota errors", () => {
  const result = readPrMetadata({}, "pr_gh_plain pr checks 42 --required --json name,bucket,state");
  expectJson(result, [{ name: "RATE_LIMIT", bucket: "pending", state: "PENDING" }], 8);
  expect(result.calls.some((args) => args.includes("rate_limit"))).toBe(false);
});
it("forwards FD3 through the API and quota probe", () => {
  const result = readPrMetadata(
    { notify: true, failure: "quota" },
    'exec 3>"$FAKE_GH_NOTIFY"; export OPENCLAW_PR_LOCK_NOTIFY_FD=3; pr_gh api repos/base-owner/base-repo/pulls/42',
  );
  expectResult(result, 75, { notifications: `${pullEndpoint}\nrate_limit\n` });
  expect(result.stderr).toContain("resource=core");
});
it("collects only complete paginated REST metadata", () => {
  const result = readPrMetadata();
  expectResult(result, 0, { stderr: "", notifications: "", attempts: 2 });
  expect(callsTo(result, pullEndpoint)).toHaveLength(2);
  expect(result.calls.filter((args) => args[0] === "api")).toHaveLength(3);
  const metadata = JSON.parse(result.stdout);
  expect(metadata).toMatchObject({
    number: 42,
    changedFiles: 101,
    headRefOid: head,
    baseRefOid: base,
    headRepository: { nameWithOwner: "fork-owner/fork-repo" },
  });
  expect(metadata.files).toHaveLength(101);
  expect(metadata.files.at(-1)).toEqual(graphqlFile("src/file-100.ts", "DELETED"));
  expect(
    result.calls.some((args) =>
      args.some((arg) => arg.includes("/check-runs?") || arg.includes("/status?")),
    ),
  ).toBe(false);
});

it.each<{ fixture: Fixture; diagnostic: string }>([
  ...[2, 0].map((changedFiles) => ({
    fixture: { changedFiles, files: [restFile()] },
    diagnostic:
      changedFiles === 2
        ? "expected 2 changed files, received 1 from paginated REST"
        : "consistent with changedFiles",
  })),
  { fixture: { failure: "exit", failureTarget: "files" }, diagnostic: "exited with status 7" },
  {
    fixture: { changedFiles: 0, files: null },
    diagnostic: "malformed paginated metadata",
  },
  ...[
    [restFile({ additions: -1 })],
    [restFile({ additions: 0.5 })],
    [restFile({ filename: "" })],
    [restFile(), restFile()],
  ].map((files) => ({
    fixture: { changedFiles: files.length, files },
    diagnostic: "files must be an explicit array",
  })),
  { fixture: { changedFiles: null }, diagnostic: "changedFiles must be a non-negative integer" },
])("rejects invalid REST files: $diagnostic ($fixture)", ({ fixture, diagnostic }) => {
  const result = readPrMetadata(fixture);
  expectResult(result, 1, { stdout: "" });
  expect(result.stderr).toContain(diagnostic);
});

it.each([
  ...[
    { number: 43 },
    { html_url: "https://github.com/other/repo/pull/42" },
    { base: { sha: null, ref: "main" } },
    { base: { sha: base, ref: "" } },
    { head: { sha: "not-a-sha", ref: "topic" } },
    { head: { ref: "topic" } },
  ].map((initialPatch) => ({ phase: "initial", fixture: { initialPatch } })),
  ...[
    { number: 43 },
    { html_url: "https://github.com/other/repo/pull/42" },
    { base: { sha: "d".repeat(40), ref: "main" } },
    { base: { sha: base, ref: "release" } },
    { head: { sha: head, ref: "different", repo: { full_name: "another/fork" } } },
  ].map((finalPatch) => ({ phase: "post-collection", fixture: { finalPatch } })),
])("rejects invalid $phase PR identity: $fixture", ({ phase, fixture }) => {
  const result = readPrMetadata(fixture);
  expectResult(result, 1, { stdout: "" });
  if (phase === "initial") {
    expectResult(result, 1, { attempts: 1, delays: [] });
  } else {
    expect(result.stderr).toContain(
      "base/head or repository identity changed or became unavailable",
    );
  }
});

it.each(["REST", "GraphQL"])("rejects moving heads after fresh %s observations", (transport) => {
  const metadata = pullFixture();
  const result = readPrMetadata({
    cacheUntilRevalidated: true,
    finalPatch: { head: { sha: "b".repeat(40), ref: "topic" } },
    ...(transport === "GraphQL"
      ? {
          coreQuotaAt: [pullEndpoint],
          graphqlResponses: [
            pullResponse(metadata),
            ...["labels", "assignees", "files"].map((field) => pullPage(field, [], false, 0)),
            pullResponse({ ...metadata, headRefOid: "b".repeat(40) }),
          ],
        }
      : {}),
  });
  expectResult(result, 1, { stdout: "" });
  expect(result.stderr).toContain("PR head changed while collecting file metadata");
});

it.each<[Fixture, number, number[], number]>([
  ...(["empty", "exit", "non-json", "null"] as const).map(
    (failure): [Fixture, number, number[], number] => [{ failure }, 3, [1, 2], 1],
  ),
  [{ failure: "empty", failureCount: 1 }, 3, [1], 0],
  [{ failure: "exit", failureTarget: "reread" }, 4, [1, 2], 1],
])("bounds metadata retries: %j", (fixture, attempts, delays, exitCode) => {
  const result = readPrMetadata(fixture);
  expectResult(result, exitCode, { attempts, delays });
  if (exitCode !== 0) {
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GitHub API failure while reading PR #42");
  }
});

it.each([
  ["pr_meta_json 42", "pull", 1],
  ["ensure_gh_api_auth", "user", 1],
  [`${viewPull("headRefOid")} --jq .headRefOid`, "pull", 75],
  [
    'node --input-type=module -e \'import { execPrGh } from "./scripts/pr-lib/github.mjs"; execPrGh(["api","repos/base-owner/base-repo/pulls/42","--input","-"], {input:Buffer.from("private payload")}, "plain")\'',
    "pull",
    1,
  ],
] as const)("labels supplemental quota without retries: %s", (command, failureTarget, exitCode) => {
  const result = readPrMetadata({ failure: "quota", failureTarget }, command);
  expectResult(result, exitCode, {
    stdout: "",
    attempts: failureTarget === "pull" ? 1 : 0,
    delays: [],
  });
  expectSupplementalQuota(result);
  if (command.includes("--input")) {
    expectPayload(result, Buffer.from("private payload"));
  }
});
it.each(["quota", "forbidden", "exit"] as const)(
  "keeps %s diagnostics private and nonfatal",
  (failure) => {
    const observation = JSON.stringify({
      main: base,
      pr: {
        ...pullFixture(),
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
    expectResult(result, 0, { stdout: "diagnostic completed\n", attempts: 1, delays: [] });
    expect(result.stderr).toContain(
      "REST pulls/42: mergeable/mergeable_state unavailable (diagnostic only)",
    );
    expect(result.stderr).not.toContain("secret-response-must-not-escape");
    expect(result.stderr).not.toContain("HTTP 503: No server is currently available");
    if (failure === "exit") {
      expect(result.stderr).not.toContain("GitHub API request failed");
    } else {
      expect(result.stderr).toContain("resource=core");
      expect(result.stderr).toContain(quotaDetail);
    }
    expect(callsTo(result, "rate_limit")).toHaveLength(failure === "exit" ? 0 : 1);
    expect(result.calls.every((args) => args[0] === "api")).toBe(true);
  },
);
it.each(["changed source", "redirected import root", "changed response parser"])(
  "rejects %s snapshot code",
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

it.each([
  ["pr_gh_plain pr view 42", "GitHub metadata reads require explicit JSON fields."],
  ["pr_gh repo view --json unsupported", "Unsupported REST repository metadata field: unsupported"],
])("rejects invalid JSON field selection: %s", (command, diagnostic) => {
  const result = readPrMetadata({}, command);
  expectResult(result, 1, { stdout: "", stderr: `${diagnostic}\n` });
});

it("preserves canonical repository identities for differently cased callers", () => {
  const result = readPrMetadata(
    {
      coreQuotaAt: ["repos/Base-Owner/Base-Repo"],
      graphqlResponses: [graphqlResponse(repository)],
    },
    "pr_gh_plain repo-authority Base-Owner/Base-Repo GitHub.com",
  );
  expectJson(result, restRepository);
});

it("accepts canonical repository casing when adopting an explicit qualified observation", () => {
  const result = readPrMetadata(
    { ghRepo: "https://GITHUB.COM/base-owner/base-repo" },
    'pr_observe 42; printf "%s\\n" "$PR_REPOSITORY_URL"',
  );
  expectResult(result, 0, { stdout: `${repository.url}\n` });
  expect(result.calls).toHaveLength(1);
});

it.each(["selected gh", "selected Git"])(
  "resolves and binds the default repository through %s",
  (tool) => {
    const selectedGh = tool === "selected gh";
    const result = readPrMetadata(
      {
        ghRepo: "",
        protectedGh: selectedGh,
        probeGit: !selectedGh,
        defaultRepoURL: "https://github.com/base-owner/base-repo",
      },
      `${selectedGh ? repoCommand : "pr_meta_json 42"}; ${assignContributor}`,
    );
    expect(result.status, result.stderr).toBe(0);
    if (selectedGh) {
      expectJson(result, { url: repository.url });
    } else {
      expect(JSON.parse(result.stdout).url).toBe("https://github.com/base-owner/base-repo/pull/42");
    }
    expect(result.calls.filter((args) => args[0] === "browse")).toEqual([["browse"], ["browse"]]);
    expectAssignedRepository(result);
  },
);
it.each([
  { command: "pr_gh pr view 42 --json headRefOid --jq .headRefOid", expected: head },
  {
    command: "pr_gh_plain repo view --json nameWithOwner --jq=.nameWithOwner",
    expected: "base-owner/base-repo",
  },
])("filters view JSON through the shell: $command", ({ command, expected }) => {
  const result = readPrMetadata({}, command);
  expectResult(result, 0, { stdout: `${expected}\n`, stderr: "" });
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
      `${viewPull("number,headRefOid")}${explicit}; ${assignContributor}${explicit}`,
    );
    expectJson(result, { number: 42, headRefOid: head });
    expect(result.calls.filter((args) => args[0] === "browse")).toEqual(
      explicit ? [] : [["browse"], ["browse"]],
    );
  },
);
it.each([
  { shape: "empty", files: [], expected: [] },
  {
    shape: "renamed",
    files: [
      restFile({
        filename: "src/renamed.ts",
        previous_filename: "src/previous.ts",
        status: "renamed",
      }),
    ],
    expected: [{ path: "src/renamed.ts", changeType: "RENAMED", additions: 0, deletions: 0 }],
  },
])("preserves $shape REST file metadata", ({ files, expected }) => {
  const result = readPrMetadata({ changedFiles: files.length, files });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).files).toEqual(expected);
});
