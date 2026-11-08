import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "../commands/status.update.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { checkUpdateStatus } from "./update-check.js";

type Graph = Record<string, string[]>;
type CountFixture = {
  graph?: Graph;
  head?: string;
  upstream?: string;
  expected: [number | null, number | null];
  shallow?: string[];
  raw?: [number, number];
};
const witness: Graph = { R: [], A: ["R"], H: ["A"], T: ["H", "A"] };
const diverged: Graph = { R: [], B: ["R"], H: ["B"], T: ["B"] };
const multipleBases: Graph = { M: [], X: ["M"], B: ["X"], H: ["M", "B"], T: ["X", "B"] };
const cases: Record<string, CountFixture> = {
  "full redundant-parent merge adds exactly one commit": { expected: [0, 1], raw: [0, 1] },
  "visible shallow merge base does not justify inflated behind count": {
    expected: [null, null],
    shallow: ["H"],
    raw: [0, 3],
  },
  "visible shallow merge base does not justify inflated ahead count": {
    expected: [null, null],
    head: "T",
    upstream: "H",
    shallow: ["H"],
    raw: [3, 0],
  },
  "equal shallow heads remain exactly current": { expected: [0, 0], upstream: "H", shallow: ["H"] },
  "full divergent ancestry remains exact": { expected: [1, 1], graph: diverged },
  "shared depth-two shallow ancestry remains exact": {
    expected: [1, 1],
    graph: diverged,
    shallow: ["B"],
  },
  "disconnected shallow tips remain unknown": {
    expected: [null, null],
    graph: diverged,
    shallow: ["H", "T"],
  },
  "disconnected complete histories remain unknown": {
    expected: [null, null],
    graph: { H: [], T: [] },
  },
  "linear shallow ancestry retains exact behind count": {
    expected: [0, 1],
    graph: { R: [], B: ["R"], H: ["B"], T: ["H"] },
    shallow: ["B"],
  },
  "linear shallow ancestry retains exact local-ahead count": {
    expected: [1, 0],
    graph: { R: [], B: ["R"], H: ["B"], T: ["H"] },
    head: "T",
    upstream: "H",
    shallow: ["B"],
  },
  "unrelated shallow boundary leaves complete comparison exact": {
    expected: [1, 1],
    graph: { R: [], B: ["R"], H: ["B"], T: ["B"], X: ["R"] },
    shallow: ["X"],
  },
  "complete alternate-common-path merge remains exact": {
    expected: [1, 1],
    graph: multipleBases,
    raw: [1, 1],
  },
  "all merge bases must rule out concealed common ancestors": {
    expected: [null, null],
    graph: multipleBases,
    shallow: ["B"],
    raw: [1, 2],
  },
  "all merge bases must also reject concealed local ancestors": {
    expected: [null, null],
    graph: multipleBases,
    head: "T",
    upstream: "H",
    shallow: ["B"],
    raw: [2, 1],
  },
  "multiple shared bases can still establish exact shallow counts": {
    expected: [1, 1],
    graph: { R: [], M: ["R"], B: ["R"], H: ["M", "B"], T: ["B", "M"] },
    shallow: ["M", "B"],
    raw: [1, 1],
  },
  "exclusive shallow side parent cannot supply exact counts": {
    expected: [null, null],
    graph: { R: [], B: ["R"], X: ["R"], H: ["B"], T: ["B", "X"] },
    shallow: ["X"],
  },
};

describe("Git update counts with incomplete ancestry", () => {
  for (const [
    caseName,
    { graph = witness, head = "H", upstream = "T", expected, shallow, raw },
  ] of Object.entries(cases)) {
    it(caseName, async () => {
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
        for (const [name, parents] of Object.entries(graph)) {
          commits[name] = git(
            "commit-tree",
            tree,
            ...parents.flatMap((parent) => ["-p", commit(parent)]),
            "-m",
            name,
          );
        }
        git("update-ref", "refs/heads/main", commit(head));
        git("update-ref", "refs/heads/upstream", commit(upstream));
        git("config", "branch.main.remote", ".");
        git("config", "branch.main.merge", "refs/heads/upstream");
        if (shallow) {
          await fs.writeFile(
            path.join(root, ".git", "shallow"),
            shallow.map(commit).join("\n") + "\n",
          );
        }
        if (raw) {
          assert.deepEqual(
            git("rev-list", "--left-right", "--count", "main...upstream").split(/\s+/u).map(Number),
            raw,
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
        assert.equal(status.git?.upstreamSha, commit(upstream));
        assert.equal(status.git?.fetchOk, null);
        assert.deepEqual([status.git?.ahead, status.git?.behind], expected);
        if (expected.includes(null)) {
          assert.doesNotMatch(line, /(?:ahead|behind) \d|up to date/u);
          assert.equal(resolveUpdateAvailability(status).gitBehind, null);
        } else if (expected[0] === 0 && expected[1] === 1) {
          assert.match(line, /behind 1\b/u);
        } else if (expected[0] === 1 && expected[1] === 0) {
          assert.match(line, /ahead 1\b/u);
          assert.doesNotMatch(line, /up to date/u);
        }
      });
    });
  }
});
