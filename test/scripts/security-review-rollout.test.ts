import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rolloutNumber = 152415;
const mergeCommit = "a".repeat(40);
const head = "b".repeat(40);
const ancestor = "c".repeat(40);
const mergedAt = "2026-09-19T12:00:00Z";
const rollout = {
  number: rolloutNumber,
  state: "closed",
  merged: true,
  merged_at: mergedAt,
  merge_commit_sha: mergeCommit,
  base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
};
const pullRequest = {
  created_at: "2026-09-01T00:00:00Z",
  head: { sha: head },
};
const comparison = {
  base_commit: { sha: mergeCommit },
  merge_base_commit: { sha: ancestor },
  status: "diverged",
};

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
      categories: {
        credentials: {
          description: "Credential storage.",
          review: "Check access.",
          paths: ["src/credentials/**"],
        },
      },
      dependencies: {
        manifests: ["**/package.json"],
        lockfiles: ["**/pnpm-lock.yaml"],
        other: ["patches/**"],
      },
      ...options.policy,
    }),
  );
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "junction");
  writeFileSync(
    path.join(root, "fixture.json"),
    JSON.stringify({
      rollout: options.rollout === undefined ? rollout : options.rollout,
      comparison: options.comparison === undefined ? comparison : options.comparison,
      pullRequest: options.pullRequest ?? pullRequest,
      apiError: options.apiError,
    }),
  );
  writeFileSync(
    path.join(root, "evaluate.mjs"),
    `import { readFileSync } from "node:fs";
import { securityReviewRollout } from "./scripts/github/security-review-rollout.mjs";
const fixture = JSON.parse(readFileSync(new URL("./fixture.json", import.meta.url), "utf8"));
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

describe("security review rollout", () => {
  it("enforces without GitHub rollout lookups after the configuration is removed", () => {
    expect(evaluate({ policy: { rollout: undefined } })).toEqual({
      status: 0,
      mode: "enforced",
      requests: [],
    });
  });

  it("does not use the synthetic merge commit before the rollout PR merges", () => {
    const result = evaluate({
      rollout: { ...rollout, state: "open", merged: false, merged_at: null },
    });
    expect(result.mode).toBe("inactive");
    expect(result.requests).toEqual([`/repos/openclaw/openclaw/pulls/${rolloutNumber}`]);
  });

  it.each(["2026-09-19T12:00:00Z", "2026-09-20T00:00:00Z"])(
    "enforces PRs created at or after rollout (%s), even on an old branch",
    (createdAt) => {
      const result = evaluate({ pullRequest: { ...pullRequest, created_at: createdAt } });
      expect(result.mode).toBe("enforced");
      expect(result.requests).toHaveLength(1);
    },
  );

  it.each(["behind", "diverged"])(
    "exempts an older PR whose head has not incorporated the rollout (%s)",
    (status) => {
      const result = evaluate({ comparison: { ...comparison, status } });
      expect(result.mode).toBe("grandfathered");
      expect(result.requests[1]).toBe(
        `/repos/openclaw/openclaw/compare/${mergeCommit}...${head}?per_page=1&page=2`,
      );
    },
  );

  it("enforces an older PR after a rebase or merge incorporates the rollout", () => {
    const result = evaluate({
      comparison: { ...comparison, merge_base_commit: { sha: mergeCommit }, status: "ahead" },
    });
    expect(result.mode).toBe("enforced");
  });

  it("enforces an older PR whose head is exactly the rollout commit", () => {
    const result = evaluate({ pullRequest: { ...pullRequest, head: { sha: mergeCommit } } });
    expect(result.mode).toBe("enforced");
    expect(result.requests).toHaveLength(1);
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
    expect(result.status).toBe(1);
    expect(result.error).toContain("Invalid security-review-policy.yml");
    expect(result.requests).toEqual([]);
  });

  it.each([
    null,
    { ...rollout, number: 1 },
    { ...rollout, base: { ref: "stable", repo: { full_name: "openclaw/openclaw" } } },
    { ...rollout, base: { ref: "main", repo: { full_name: "contributor/fork" } } },
    { ...rollout, merged: undefined },
    { ...rollout, merged: false },
    { ...rollout, state: "open" },
    { ...rollout, merged_at: null },
    { ...rollout, merged_at: "2026-02-30T12:00:00Z" },
    { ...rollout, merge_commit_sha: "main" },
  ])("does not grant an exemption for invalid rollout metadata (%j)", (value) => {
    const result = evaluate({ rollout: value });
    expect(result.status).toBe(1);
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain("Cannot determine security review rollout");
  });

  it.each([
    { ...pullRequest, created_at: undefined },
    { ...pullRequest, created_at: "not a timestamp" },
    { ...pullRequest, head: { sha: "main" } },
  ])("does not grant an exemption for invalid evaluated PR metadata (%j)", (value) => {
    const result = evaluate({ pullRequest: value });
    expect(result.status).toBe(1);
    expect(result.error).toContain("Cannot determine security review rollout");
  });

  it.each([
    null,
    { ...comparison, base_commit: { sha: ancestor } },
    { ...comparison, merge_base_commit: {} },
    { ...comparison, status: "ahead" },
    { ...comparison, merge_base_commit: { sha: mergeCommit } },
  ])("does not grant an exemption for incomplete or inconsistent ancestry (%j)", (value) => {
    const result = evaluate({ comparison: value });
    expect(result.status).toBe(1);
    expect(result.error).toContain("Cannot determine security review rollout");
  });

  it.each(["rollout", "comparison"] as const)(
    "does not convert a GitHub %s error into an exemption",
    (apiError) => {
      const result = evaluate({ apiError });
      expect(result.status).toBe(1);
      expect(result.error).toBe("GitHub unavailable");
    },
  );
});
