import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "../commands/status.update.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { checkUpdateStatus } from "./update-check.js";

type Graph = Record<string, string[]>;
type CountCase = {
  name: string;
  graph: Graph;
  head: string;
  upstream: string;
  shallow?: string[];
  expected: [number | null, number | null];
  raw?: [number, number];
};

const witness: Graph = { R: [], A: ["R"], H: ["A"], T: ["H", "A"] };
const diverged: Graph = { R: [], B: ["R"], H: ["B"], T: ["B"] };
const multipleBases: Graph = { M: [], X: ["M"], B: ["X"], H: ["M", "B"], T: ["X", "B"] };
const cases: CountCase[] = [
  {
    name: "full redundant-parent merge adds exactly one commit",
    graph: witness,
    head: "H",
    upstream: "T",
    expected: [0, 1],
    raw: [0, 1],
  },
  {
    name: "visible shallow merge base does not justify inflated behind count",
    graph: witness,
    head: "H",
    upstream: "T",
    shallow: ["H"],
    expected: [null, null],
    raw: [0, 3],
  },
  {
    name: "visible shallow merge base does not justify inflated ahead count",
    graph: witness,
    head: "T",
    upstream: "H",
    shallow: ["H"],
    expected: [null, null],
    raw: [3, 0],
  },
  {
    name: "equal shallow heads remain exactly current",
    graph: witness,
    head: "H",
    upstream: "H",
    shallow: ["H"],
    expected: [0, 0],
  },
  {
    name: "full divergent ancestry remains exact",
    graph: diverged,
    head: "H",
    upstream: "T",
    expected: [1, 1],
  },
  {
    name: "shared depth-two shallow ancestry remains exact",
    graph: diverged,
    head: "H",
    upstream: "T",
    shallow: ["B"],
    expected: [1, 1],
  },
  {
    name: "disconnected shallow tips remain unknown",
    graph: diverged,
    head: "H",
    upstream: "T",
    shallow: ["H", "T"],
    expected: [null, null],
  },
  {
    name: "disconnected complete histories remain unknown",
    graph: { H: [], T: [] },
    head: "H",
    upstream: "T",
    expected: [null, null],
  },
  {
    name: "linear shallow ancestry retains exact behind count",
    graph: { R: [], B: ["R"], H: ["B"], T: ["H"] },
    head: "H",
    upstream: "T",
    shallow: ["B"],
    expected: [0, 1],
  },
  {
    name: "linear shallow ancestry retains exact local-ahead count",
    graph: { R: [], B: ["R"], H: ["B"], T: ["H"] },
    head: "T",
    upstream: "H",
    shallow: ["B"],
    expected: [1, 0],
  },
  {
    name: "unrelated shallow boundary leaves complete comparison exact",
    graph: { ...diverged, X: ["R"] },
    head: "H",
    upstream: "T",
    shallow: ["X"],
    expected: [1, 1],
  },
  {
    name: "complete alternate-common-path merge remains exact",
    graph: multipleBases,
    head: "H",
    upstream: "T",
    expected: [1, 1],
    raw: [1, 1],
  },
  {
    name: "all merge bases must rule out concealed common ancestors",
    graph: multipleBases,
    head: "H",
    upstream: "T",
    shallow: ["B"],
    expected: [null, null],
    raw: [1, 2],
  },
  {
    name: "all merge bases must also reject concealed local ancestors",
    graph: multipleBases,
    head: "T",
    upstream: "H",
    shallow: ["B"],
    expected: [null, null],
    raw: [2, 1],
  },
  {
    name: "multiple shared bases can still establish exact shallow counts",
    graph: { R: [], M: ["R"], B: ["R"], H: ["M", "B"], T: ["B", "M"] },
    head: "H",
    upstream: "T",
    shallow: ["M", "B"],
    expected: [1, 1],
    raw: [1, 1],
  },
  {
    name: "exclusive shallow side parent cannot supply exact counts",
    graph: { R: [], B: ["R"], X: ["R"], H: ["B"], T: ["B", "X"] },
    head: "H",
    upstream: "T",
    shallow: ["X"],
    expected: [null, null],
  },
];

describe("Git update counts with incomplete ancestry", () => {
  for (const fixture of cases) {
    it(fixture.name, async () => {
      await withTestDir({ prefix: "openclaw-shallow-counts-" }, async (root) => {
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          XDG_CONFIG_HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
          GIT_CONFIG_SYSTEM: path.join(root, "empty-gitconfig"),
          GIT_CONFIG_COUNT: "0",
          GIT_AUTHOR_NAME: "OpenClaw Test",
          GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
          GIT_COMMITTER_NAME: "OpenClaw Test",
          GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
          GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "file",
          LC_ALL: "C",
        };
        await fs.writeFile(path.join(root, "empty-gitconfig"), "");
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: root,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        git("init", "--quiet");
        git("symbolic-ref", "HEAD", "refs/heads/main");
        const tree = execFileSync("git", ["mktree"], {
          cwd: root,
          env,
          input: "",
          encoding: "utf8",
        }).trim();
        const commits: Record<string, string> = {};
        const commit = (name: string) => {
          const sha = commits[name];
          assert.ok(sha, `Missing fixture commit ${name}`);
          return sha;
        };
        for (const [name, parents] of Object.entries(fixture.graph)) {
          commits[name] = git(
            "commit-tree",
            tree,
            ...parents.flatMap((parent) => ["-p", commit(parent)]),
            "-m",
            name,
          );
        }
        git("update-ref", "refs/heads/main", commit(fixture.head));
        git("update-ref", "refs/heads/upstream", commit(fixture.upstream));
        git("config", "branch.main.remote", ".");
        git("config", "branch.main.merge", "refs/heads/upstream");
        if (fixture.shallow) {
          await fs.writeFile(
            path.join(root, ".git", "shallow"),
            fixture.shallow.map(commit).join("\n") + "\n",
          );
        }
        if (fixture.raw) {
          assert.deepEqual(
            git("rev-list", "--left-right", "--count", "main...upstream").split(/\s+/u).map(Number),
            fixture.raw,
          );
        }
        const gitEnv = Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.startsWith("GIT_"))
            .map((key) => [key, undefined]),
        );
        const status = await withEnvAsync({ ...gitEnv, ...env }, () =>
          checkUpdateStatus({ root, fetchGit: false, includeRegistry: false, timeoutMs: 5000 }),
        );
        const line = formatUpdateOneLiner(status);
        const rawCounts = git("rev-list", "--left-right", "--count", "main...upstream");
        const baseResult = spawnSync("git", ["merge-base", "--all", "main", "upstream"], {
          cwd: root,
          env,
          encoding: "utf8",
        });
        assert.equal(baseResult.error, undefined);
        assert.ok(baseResult.status === 0 || baseResult.status === 1);
        console.log(
          JSON.stringify({
            fixture: fixture.name,
            commits,
            shallow: fixture.shallow ?? [],
            rawCounts,
            mergeBases: { code: baseResult.status, stdout: baseResult.stdout.trim() },
            ahead: status.git?.ahead,
            behind: status.git?.behind,
            line,
            availability: resolveUpdateAvailability(status),
          }),
        );
        assert.equal(status.git?.upstreamSha, commit(fixture.upstream));
        assert.equal(status.git?.fetchOk, null);
        assert.deepEqual([status.git?.ahead, status.git?.behind], fixture.expected);
        if (fixture.expected.includes(null)) {
          assert.doesNotMatch(line, /(?:ahead|behind) \d|up to date/u);
          assert.equal(resolveUpdateAvailability(status).gitBehind, null);
        } else if (fixture.expected[0] === 0 && fixture.expected[1] === 1) {
          assert.match(line, /behind 1\b/u);
        } else if (fixture.expected[0] === 1 && fixture.expected[1] === 0) {
          assert.match(line, /ahead 1\b/u);
          assert.doesNotMatch(line, /up to date/u);
        }
      });
    });
  }
});
