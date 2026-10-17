import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rolloutNumber = 152415;
const mergeCommit = "a".repeat(40);
const head = "b".repeat(40);
const ancestor = "c".repeat(40);
const mergedAt = "2026-09-19T12:00:00Z";
const rolloutPath = `/repos/openclaw/openclaw/pulls/${rolloutNumber}`;
const comparisonPath = `/repos/openclaw/openclaw/compare/${mergeCommit}...${head}?per_page=1&page=2`;
const reads = [rolloutPath, comparisonPath];
const rollout = {
  number: rolloutNumber,
  state: "closed",
  merged: true,
  merged_at: mergedAt,
  merge_commit_sha: mergeCommit,
  base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
};
const pullRequest = { created_at: "2026-09-01T00:00:00Z", head: { sha: head } };
const comparison = {
  base_commit: { sha: mergeCommit },
  merge_base_commit: { sha: ancestor },
  status: "diverged",
};

const rebased = { ...comparison, merge_base_commit: { sha: mergeCommit }, status: "ahead" };

type Options = {
  policy?: object;
  rollout?: object | null;
  pullRequest?: object;
  comparison?: object | null;
  apiError?: "rollout" | "comparison";
};

function evaluate(options: Options = {}) {
  const root = tempDirs.make("security-review-rollout-");
  for (const filename of ["security-review-policy.mjs", "security-review-rollout.mjs"]) {
    const target = path.join(root, "scripts/github", filename);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.resolve("scripts/github", filename), target);
  }
  mkdirSync(path.join(root, ".github"));
  writeFileSync(
    path.join(root, ".github/security-review-policy.yml"),
    stringify({
      rollout: { "pull-request": rolloutNumber },
      exclude: {},
      categories: { test: { description: "Test", review: "Check", paths: ["test/**"] } },
      dependencies: { manifests: ["package.json"], lockfiles: ["lock"], other: ["patch"] },
      ...options.policy,
    }),
  );
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  writeFileSync(
    path.join(root, "evaluate.mjs"),
    `import { securityReviewRollout } from "./scripts/github/security-review-rollout.mjs";
const fixture = ${JSON.stringify({
      rollout: options.rollout === undefined ? rollout : options.rollout,
      comparison: options.comparison === undefined ? comparison : options.comparison,
      pullRequest: options.pullRequest ?? pullRequest,
      apiError: options.apiError,
    })};
const requests = [];
const api = {
  async request(path) {
    requests.push(path);
    const key = path.includes("/pulls/") ? "rollout" : "comparison";
    if (fixture.apiError === key) throw new Error("GitHub unavailable");
    return fixture[key];
  },
};
try {
  const result = await securityReviewRollout({
    api, owner: "openclaw", repo: "openclaw", pullRequest: fixture.pullRequest,
  });
  console.log(JSON.stringify({ ...result, requests }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, requests }));
  process.exitCode = 1;
}
`,
  );
  const result = spawnSync(process.execPath, [path.join(root, "evaluate.mjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(result.stderr).toBe("");
  return {
    status: result.status,
    ...(JSON.parse(result.stdout) as { mode?: string; error?: string; requests: string[] }),
  };
}

it.each<[Options, string, number]>([
  [{ policy: { rollout: undefined } }, "enforced", 0],
  [{ rollout: { ...rollout, state: "open", merged: false, merged_at: null } }, "inactive", 1],
  [{ pullRequest: { ...pullRequest, created_at: mergedAt } }, "enforced", 1],
  [{ pullRequest: { ...pullRequest, head: { sha: mergeCommit } } }, "enforced", 1],
  [{ comparison: { ...comparison, status: "behind" } }, "grandfathered", 2],
  [{ comparison: rebased }, "enforced", 2],
])("resolves rollout %j", (options, mode, count) => {
  expect(evaluate(options)).toEqual({ status: 0, mode, requests: reads.slice(0, count) });
});

it.each([
  null,
  {},
  { "pull-request": 0 },
  { "pull-request": "152415" },
  { "pull-request": 1.5 },
  { "pull-request": Number.MAX_SAFE_INTEGER + 1 },
  { "pull-request": rolloutNumber, unknown: true },
])("rejects invalid rollout configuration (%j)", (value) => {
  const result = evaluate({ policy: { rollout: value } });
  expect(result).toMatchObject({ status: 1, requests: [] });
  expect(result.error).toContain("Invalid security-review-policy.yml");
});

it.each<Options>([
  ...[
    null,
    { ...rollout, number: 1 },
    { ...rollout, base: { ref: "stable", repo: { full_name: "openclaw/openclaw" } } },
    { ...rollout, base: { ref: "main", repo: { full_name: "contributor/fork" } } },
    { ...rollout, merged: false },
    { ...rollout, state: "open" },
    { ...rollout, merged_at: null },
    { ...rollout, merged_at: "2026-02-30T12:00:00Z" },
  ].map((value) => ({ rollout: value })),
  ...[
    { ...pullRequest, created_at: undefined },
    { ...pullRequest, created_at: "not a timestamp" },
    { ...pullRequest, head: { sha: "main" } },
  ].map((value) => ({ pullRequest: value })),
  ...[
    null,
    { ...comparison, base_commit: { sha: ancestor } },
    { ...comparison, merge_base_commit: {} },
    { ...comparison, status: "ahead" },
    { ...comparison, merge_base_commit: { sha: mergeCommit } },
  ].map((value) => ({ comparison: value })),
])("does not grant an exemption for invalid metadata (%j)", (options) => {
  const result = evaluate(options);
  expect([result.status, result.mode]).toEqual([1, undefined]);
  expect(result.error).toContain("Cannot determine security review rollout");
});

it("does not convert a GitHub comparison error into an exemption", () => {
  const result = evaluate({ apiError: "comparison" });
  expect(result).toMatchObject({ status: 1, error: "GitHub unavailable" });
});
