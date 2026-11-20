import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeBaselineGitHubAdapter } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const requests = {
  rest: ["api", "repos/fixture/repo/pulls/42"],
  graphql: ["api", "graphql", "-f", "query=query($owner:String!){repository{name}}", "--include"],
};
type Request = keyof typeof requests;

function fixture(format = "sha1") {
  const root = dirs.make("openclaw-pr-fixture-github-");
  const bin = join(root, "bin");
  const local = join(root, ".local");
  mkdirSync(bin);
  mkdirSync(local);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main", `--object-format=${format}`);
  const tree = git("write-tree");
  const commit = (label: string) => git("commit-tree", tree, "-m", label);
  const main = commit("main");
  const topic = commit("topic");
  git("update-ref", "refs/heads/main", main);
  git("update-ref", "refs/heads/topic", topic);
  const callsPath = join(local, "git-calls.jsonl");
  writeFileSync(callsPath, "");
  // Record real Git child boundaries so the regression detects separate
  // launches, not just equivalent JSON from the adapter.
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_GIT_CALLS, JSON.stringify(args) + '\\n');
const result = cp.spawnSync('git', args, {
 env: {...process.env, PATH:process.env.FIXTURE_NATIVE_PATH}, encoding:'utf8'
});
if (result.error) throw result.error;
if (result.signal) { process.kill(process.pid, result.signal); }
else {
 let output = result.stdout;
 const fault = process.env.FIXTURE_REF_OUTPUT;
 if (result.status === 0 && fault) {
  const lines = output.trim().split('\\n');
  if (fault === 'missing') output = lines[0] + '\\n';
  if (fault === 'extra') output += lines[0] + '\\n';
  if (fault === 'invalid') output = lines[0] + '\\nnot-an-oid\\n';
 }
 process.stdout.write(output);
 process.stderr.write(result.stderr);
 if (fault === 'failed') process.stderr.write('fixture ref child failed\\n');
 process.exit(fault === 'failed' ? 73 : result.status);
}
`,
    { mode: 0o755 },
  );
  const adapter = join(bin, "gh");
  writeBaselineGitHubAdapter(adapter, ["docs/first.md", "docs/second.md"]);
  const run = (kind: Request, fault = "") =>
    spawnSync(requireNodeTool("node"), [adapter, ...requests[kind]], {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}${delimiter}${env.PATH ?? ""}`,
        FIXTURE_NATIVE_PATH: env.PATH,
        FIXTURE_GIT_CALLS: callsPath,
        FIXTURE_REPO: root,
        FIXTURE_REF_OUTPUT: fault,
      },
      encoding: "utf8",
    });
  const calls = (): string[][] =>
    readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const response = (kind: Request) => {
    const result = run(kind);
    expect(result.status, result.stderr).toBe(0);
    const header = "HTTP/2.0 200 OK\r\n\r\n";
    if (kind === "graphql") expect(result.stdout.startsWith(header)).toBe(true);
    return JSON.parse(kind === "graphql" ? result.stdout.slice(header.length) : result.stdout);
  };
  const writeLocal = (name: string, value: unknown) =>
    writeFileSync(join(local, name), JSON.stringify(value));
  return { root, git, commit, main, topic, calls, run, response, writeLocal };
}

describePosix("baseline fixture GitHub ref responses", () => {
  it.each([
    ["rest", "sha1"],
    ["graphql", "sha1"],
    ["rest", "sha256"],
    ["graphql", "sha256"],
  ] as const)(
    "resolves fresh ordered %s refs with %s in one child per response",
    (kind, format) => {
      const f = fixture(format);
      const expectedArgs = [
        "-C",
        f.root,
        "rev-parse",
        ...(kind === "rest" ? ["main", "topic"] : ["topic", "main"]),
      ];
      const expectRefs = (main: string, topic: string) => {
        const result = f.response(kind);
        if (kind === "rest") {
          expect(result.base.sha).toBe(main);
          expect(result.head.sha).toBe(topic);
          expect(result.changed_files).toBe(2);
        } else {
          expect(result.data.repository.ref.target.oid).toBe(main);
          expect(result.data.repository.pullRequest.headRefOid).toBe(topic);
        }
      };
      expectRefs(f.main, f.topic);
      expect(f.calls()).toEqual([expectedArgs]);
      const nextMain = f.commit("moved main");
      const nextTopic = f.commit("moved topic");
      f.git("update-ref", "refs/heads/main", nextMain);
      f.git("update-ref", "refs/heads/topic", nextTopic);
      expectRefs(nextMain, nextTopic);
      expect(f.calls()).toEqual([expectedArgs, expectedArgs]);
    },
  );

  it("applies REST overrides after resolving the live branches", () => {
    const f = fixture();
    const override = { state: "closed", head: { ref: "replaced", sha: f.main } };
    f.writeLocal("live.json", override);
    const result = f.response("rest");
    expect(result.state).toBe(override.state);
    expect(result.head).toEqual(override.head);
    expect(result.base.sha).toBe(f.main);
    expect(f.calls()).toEqual([["-C", f.root, "rev-parse", "main", "topic"]]);
  });

  it("uses a supplied GraphQL PR without requiring its old topic branch", () => {
    const f = fixture();
    const supplied = { id: "PR_supplied", state: "CLOSED", headRefOid: f.topic };
    f.writeLocal("merge-live.json", supplied);
    f.git("update-ref", "-d", "refs/heads/topic");
    const result = f.response("graphql").data.repository;
    expect(result.pullRequest).toEqual(supplied);
    expect(result.ref.target.oid).toBe(f.main);
    expect(f.calls()).toEqual([["-C", f.root, "rev-parse", "main"]]);
  });

  it.each(["rest", "graphql"] as const)("refuses missing live refs for %s", (kind) => {
    const f = fixture();
    f.git("update-ref", "-d", "refs/heads/topic");
    const result = f.run(kind);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown revision or path not in the working tree");
    expect(result.stdout).toBe("");
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["missing", "extra", "invalid", "failed"])(
    "refuses %s child output instead of publishing a partial response",
    (fault) => {
      const f = fixture();
      const result = f.run("rest", fault);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        fault === "failed" ? "fixture ref child failed" : "Incomplete or invalid fixture Git refs.",
      );
      expect(result.stdout).toBe("");
      expect(f.calls()).toEqual([["-C", f.root, "rev-parse", "main", "topic"]]);
    },
  );
});
