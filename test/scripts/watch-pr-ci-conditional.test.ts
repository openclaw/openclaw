import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../src/test-utils/temp-dir.js";
import { runWatcher, sha } from "./watch-pr-ci.test-support.js";

const fixture = [
  "#!/usr/bin/env node",
  'const fs = require("node:fs");',
  "const args = process.argv.slice(2);",
  'const calls = fs.readFileSync(callsPath, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);',
  'fs.appendFileSync(callsPath, JSON.stringify(args) + "\\n");',
  'const runPath = "repos/openclaw/openclaw/actions/runs/201";',
  "const runReads = calls.filter(call => call.includes(runPath)).length;",
  'const legacyReads = calls.filter(call => call[0] === "run").length;',
  "const current = Math.max(runReads, legacyReads - 1);",
  'const head = outcome === "head-moved" && current >= 2 ? "b".repeat(40) : sha;',
  "function answer(body, etag) {",
  '  const unchanged = args.includes("If-None-Match: " + etag);',
  '  if (unchanged) { process.exitCode = 1; console.error("gh: HTTP 304"); }',
  '  process.stdout.write("HTTP/2 " + (unchanged ? "304 Not Modified" : "200 OK") + "\\r\\nETag: " + etag + "\\r\\n\\r\\n" + (unchanged ? "" : JSON.stringify(body)));',
  "}",
  'if (args[0] === "browse") console.log("https://github.com/openclaw/openclaw");',
  'else if (args.includes("repos/openclaw/openclaw/pulls/42")) console.log(JSON.stringify({state: "open", html_url: "https://github.com/openclaw/openclaw/pull/42", mergeable: true, head: {sha: head}}));',
  'else if (args.some(arg => arg.includes("/actions/workflows/ci.yml/runs"))) console.log(JSON.stringify({workflow_runs: [{id: 201}]}));',
  'else if (args[0] === "run") console.log(JSON.stringify({status: current >= 2 ? "completed" : "queued", conclusion: current >= 2 ? outcome : null}));',
  'else if (args.includes(runPath)) answer({id: 201, head_sha: sha, run_attempt: 1, status: runReads >= 2 ? "completed" : "queued", conclusion: runReads >= 2 ? outcome : null}, runReads >= 2 ? \'"run-b"\' : \'W/"run-a"\');',
  'else if (args.some(arg => arg.startsWith(runPath + "/attempts/1/jobs?"))) answer({total_count: 1, jobs: [{name: "tests", status: "queued", conclusion: null}]}, \'"jobs-a"\');',
  'else throw new Error("unexpected request " + JSON.stringify(args));',
];

describe.skipIf(process.platform === "win32")("conditional CI-run polling", () => {
  it.each(["success", "failure", "head-moved"])(
    "revalidates unchanged run/jobs without losing %s transitions",
    async (outcome) => {
      await withTempDir("openclaw-ci-conditional-", async (root) => {
        const callsPath = join(root, "calls.jsonl");
        writeFileSync(callsPath, "");
        const program = [
          fixture[0],
          "const callsPath = " + JSON.stringify(callsPath) + ";",
          "const outcome = " + JSON.stringify(outcome) + ";",
          "const sha = " + JSON.stringify(sha) + ";",
          ...fixture.slice(1),
        ].join("\n");
        const result = await runWatcher(program, sha, ["--completion", "ci-run", "--timeout", "3"]);
        expect(result.status, result.stdout + "\n" + result.stderr).toBe(
          outcome === "success" ? 0 : outcome === "failure" ? 15 : 11,
        );
        expect(result.stdout).toContain(
          outcome === "success"
            ? "\nGREEN"
            : outcome === "failure"
              ? "FAILING checks=CI workflow (failure)"
              : "HEAD-MOVED",
        );
        const calls: string[][] = readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((call) => call.includes('If-None-Match: W/"run-a"'))).toHaveLength(
          outcome === "head-moved" ? 1 : 2,
        );
        expect(calls.filter((call) => call.includes('If-None-Match: "jobs-a"'))).toHaveLength(1);
        expect(result.stdout.match(/jobs=1 running=0 queued=1/g)).toHaveLength(2);
      });
    },
  );
});
