import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helperPath = path.join(
  repoRoot,
  ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh",
);
const { createTempDir } = createScriptTestHarness();

type Fixture = {
  timeoutActivity?: boolean;
  search?: unknown[];
  fail?: string[];
};
type Request = { route: string; args: string[]; output: string };

function runHelper(args: string[], fixture: Fixture = {}) {
  const dir = createTempDir("github-activity-helper-");
  const logPath = path.join(dir, "gh.log");
  const outputPath = path.join(dir, "stdout");
  writeFileSync(logPath, "");
  const ghPath = path.join(dir, "gh");
  const bypassPath = path.join(dir, "gh-plain");
  const epoch = Date.parse("2026-08-26T12:34:56Z") / 1000;
  writeFileSync(
    path.join(dir, "date"),
    `#!/bin/sh
if [ "$*" = "-u +%s" ]; then printf '%s\\n' '${epoch}'; else exec /bin/date "$@"; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    ghPath,
    `#!/bin/bash
set -euo pipefail
jq -cn --arg route "\${0##*/}" --rawfile output "$OUTPUT" --args \
  '{route: $route, args: $ARGS.positional, output: $output}' -- "$@" >> "$REQUEST_LOG"
body=$(jq -cn --argjson fixture "$FIXTURE" --slurpfile requests "$REQUEST_LOG" --args '
  $ARGS.positional as $args |
  if any($fixture.fail[]?; . as $needle | any($args[]; contains($needle))) then
    null | halt_error(1)
  elif $fixture.timeoutActivity and $args[0] == "api" and ($args[1] | startswith("users/") | not) then
    null | halt_error(124)
  elif $args[0] == "api" and ($args[1] | startswith("users/")) then
      {login: "Canonical", name: "Example Author", created_at: "2010-09-21T00:00:00Z", type: "User"}
  elif $args[0] == "api" and ($args[1] | startswith("search/")) then
    ((([$requests[] | select(.args[1] | startswith("search/"))] | length) - 1) % 3) as $index |
    if $fixture.search and $index < ($fixture.search | length) then $fixture.search[$index] else
      {total_count: ([2345, 0, 9876][$index]), incomplete_results: false, items: []}
    end
  elif $args[0] == "api" and $args[1] == "graphql" then
      {data: {user: {contributionsCollection: {
        totalCommitContributions: 8, totalIssueContributions: 1,
        totalPullRequestContributions: 3, totalPullRequestReviewContributions: 2
      }}}}
  else null | halt_error(64) end
' -- "$@" 2>/dev/null) || exit "$?"
while [[ $# -gt 0 && "$1" != "--jq" ]]; do
  shift
done
printf '%s\\n' "$body" | jq -cr "\${2:-.}"
`,
    { mode: 0o755 },
  );
  writeFileSync(bypassPath, readFileSync(ghPath), { mode: 0o755 });
  const result = spawnSync(
    "bash",
    ["-c", 'exec bash "$@" > "$OUTPUT"', "activity-test", helperPath, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      // Only CLI fixtures and command lookup cross this boundary; no live auth/config.
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        HOME: dir,
        GH_TOKEN: "offline-fixture",
        OPENCLAW_GH_BIN: bypassPath,
        FIXTURE: JSON.stringify(fixture),
        REQUEST_LOG: logPath,
        OUTPUT: outputPath,
      },
    },
  );
  const requests = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Request);
  return { status: result.status, stdout: readFileSync(outputPath, "utf8"), requests };
}

describe("openclaw-pr-maintainer github activity helper", () => {
  it("prints canonical identity before the first activity request returns a timeout", () => {
    const { requests } = runHelper(["alias"], { timeoutActivity: true });
    expect(requests[0]?.args[1]).toBe("users/alias");
    expect(requests[1]?.output).toContain(
      "Example Author (@Canonical, User, account created 2010-09-21",
    );
  });

  it("uses three single-page search aggregates regardless of row count", () => {
    const { status, stdout, requests } = runHelper(["alias"]);
    expect(status).toBe(0);
    expect(requests).toHaveLength(4);
    expect(stdout).toContain("2345 PRs, 0 issues, 9876 commits");
    expect(requests.every((request) => request.route === "gh")).toBe(true);
    const searches = requests.slice(1).map(({ args }) => {
      expect(args).toEqual(["api", expect.any(String), "--cache", "1h"]);
      const url = new URL(args[1] ?? "", "https://api.github.test/");
      expect(url.searchParams.get("per_page")).toBe("1");
      expect(url.searchParams.get("q")).toContain("repo:openclaw/openclaw author:Canonical");
      return url;
    });
    expect(searches.map((url) => url.pathname)).toEqual([
      "/search/issues",
      "/search/issues",
      "/search/commits",
    ]);
    expect(searches[0]?.searchParams.get("q")).toContain("is:pr");
    expect(searches[1]?.searchParams.get("q")).toContain("is:issue");
    expect(searches[2]?.searchParams.get("q")).toContain("committer-date:");
    expect(stdout).toContain("index/cache may lag");
  });

  it("distinguishes incomplete, missing, and failed searches from a valid zero", () => {
    const { status, stdout, requests } = runHelper(["alias"], {
      search: [{ total_count: 7, incomplete_results: true }, {}, {}],
      fail: ["search/commits"],
    });
    expect(status).toBe(1);
    expect(requests).toHaveLength(4);
    expect(stdout).toContain("incomplete (reported 7) PRs");
    expect(stdout).toContain("unavailable (invalid response) issues");
    expect(stdout).toContain("unavailable (request failed) commits");
    expect(stdout).not.toContain("0 commits");
  });

  it("keeps a longer repo window separate from the capped global window", () => {
    const { status, stdout, requests } = runHelper(["--months", "24", "--global", "alias"]);
    expect(status).toBe(0);
    expect(requests).toHaveLength(5);
    expect(requests.map(({ args }) => args[args.indexOf("--cache") + 1])).toEqual(
      Array(5).fill("1h"),
    );
    const repoUrl = requests[1]?.args[1] ?? "";
    const repoQuery = new URL(repoUrl, "https://api.github.test").searchParams.get("q") ?? "";
    const repoRange = /created:([^ ]+)\.\.([^ ]+)/.exec(repoQuery);
    const graphql = requests[4]?.args ?? [];
    const from = graphql.find((arg) => arg.startsWith("from="))?.slice(5) ?? "";
    const to = graphql.find((arg) => arg.startsWith("to="))?.slice(3) ?? "";
    expect(repoRange?.slice(1)).toEqual(["2024-08-26T00:00:00Z", "2026-08-25T23:59:59Z"]);
    expect([from, to]).toEqual(["2025-08-26T00:00:00Z", "2026-08-26T00:00:00Z"]);
    expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(366 * 86400000);
    expect(stdout).toContain("GitHub contributions last 12mo");
    expect(stdout).toContain("requested 24mo");
    expect(stdout).toContain("8 commits, 3 PRs, 1 issues, 2 reviews");
    expect(stdout).not.toContain("GitHub public");
  });

  it("continues other logins after profile failure without activity for the unknown identity", () => {
    const { status, stdout, requests } = runHelper(["missing", "alias"], {
      fail: ["users/missing"],
    });
    expect(status).toBe(1);
    expect(requests).toHaveLength(5);
    expect(stdout).toContain("@missing (profile unavailable; account age unknown)");
    expect(stdout).toContain("Example Author (@Canonical");
    expect(requests[1]?.args[1]).toBe("users/alias");
  });
  it("continues later logins after a failed global request without falling back to scans", () => {
    const { status, stdout, requests } = runHelper(["--global", "first", "second"], {
      fail: ["graphql"],
    });
    expect(status).toBe(1);
    expect(requests).toHaveLength(10);
    expect(stdout.match(/unavailable \(request failed\)/g)).toHaveLength(2);
    expect(requests[5]?.args[1]).toBe("users/second");
  });
});
