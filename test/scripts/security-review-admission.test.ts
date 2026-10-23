import { expect, it } from "vitest";
import { revalidatePublishedSecurityClearance } from "../../scripts/github/guard-review.mjs";

const head = "a".repeat(40);
const rolloutCommit = "b".repeat(40);
const ciFailure = "CI must complete successfully; review updates automatically";
const mergedPull = { state: "closed", merged: true, maintainer_can_modify: false };
const securityVeto = { description: "PR #7: A maintainer must approve the current PR revision" };
const ciProjections: [string, string][] = [
  ["failure", ciFailure],
  ["success", "CI and applicable security review requirements passed"],
  ["pending", "Waiting for CI; review updates automatically"],
];
const publisher = {
  url: "https://github.com/openclaw/openclaw/actions/runs/100",
  startedAt: "2026-09-27T12:00:00Z",
  completedAt: "2026-09-27T12:01:00Z",
};

function fixture(needsApproval = false, projectionState = "failure", projection = ciFailure) {
  const pullRequest = {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    maintainer_can_modify: true,
    created_at: "2026-09-01T00:00:00Z",
    user: { id: 1, login: "contributor", type: "User" },
    head: { sha: head },
    base: { ref: "main" },
  };
  const state = {
    currentPull: structuredClone(pullRequest),
    rollout: "enforced" as "enforced" | "grandfathered" | "inactive",
    role: needsApproval ? "maintain" : "write",
    afterPermission: () => {},
  };
  const notice = (marker: string) => ({
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify({ head, base: "main", requestedAt: "2026-09-27T11:00:00Z" })} -->`,
    updated_at: "2026-09-27T11:00:00Z",
  });
  const approval = {
    user: { id: 2, login: "maintainer", type: "User" },
    body: "/allow-dependencies-change\n/allow-security-sensitive-change",
    created_at: "2026-09-27T11:30:00Z",
    updated_at: "2026-09-27T11:30:00Z",
    html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-11",
  };
  const comments = needsApproval
    ? [
        notice("<!-- openclaw:dependency-graph-guard -->"),
        notice("<!-- openclaw:security-sensitive-guard -->"),
        approval,
      ]
    : [];
  const status = (id: number, context: string, description: string, result = "success") => ({
    id,
    context,
    state: result,
    description: `PR #7: ${description}`,
    creator: { login: "github-actions[bot]", type: "Bot" },
    target_url: publisher.url,
    created_at: id === 3 ? "2026-09-27T12:00:40Z" : "2026-09-27T12:00:20Z",
    updated_at: id === 3 ? "2026-09-27T12:00:40Z" : "2026-09-27T12:00:20Z",
  });
  const dependency = status(
    1,
    "openclaw/dependency-review",
    needsApproval
      ? "Dependency review requirements satisfied."
      : "No dependency changes require review.",
  );
  const sensitive = status(
    2,
    "openclaw/security-sensitive-review",
    needsApproval ? "Sensitive changes have maintainer authority" : "No sensitive product changes",
  );
  const combined = status(3, "openclaw/ci-gate", projection, projectionState);
  const statuses = [dependency, sensitive, combined];
  const prefix = "/repos/openclaw/openclaw";
  const pullPath = `${prefix}/pulls/7`;
  const issuePath = `${prefix}/issues/7`;
  const routes: Record<string, () => unknown> = {
    [pullPath]: () => state.currentPull,
    [`${prefix}/pulls/152415`]: () => ({
      number: 152415,
      state: state.rollout === "inactive" ? "open" : "closed",
      merged: state.rollout !== "inactive",
      merged_at: state.rollout === "inactive" ? null : "2026-09-19T00:00:00Z",
      merge_commit_sha: rolloutCommit,
      base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
    }),
    [`${prefix}/compare/${rolloutCommit}...${head}?per_page=1&page=2`]: () => ({
      base_commit: { sha: rolloutCommit },
      merge_base_commit: { sha: state.rollout === "enforced" ? rolloutCommit : "c".repeat(40) },
      status: state.rollout === "enforced" ? "ahead" : "diverged",
    }),
    [`${prefix}/collaborators/contributor/permission`]: () => ({ role_name: "write" }),
    [`${prefix}/collaborators/maintainer/permission`]: () => {
      state.afterPermission();
      return { role_name: state.role };
    },
  };
  const review = {
    owner: "openclaw",
    repo: "openclaw",
    pullRequest,
    pullPath,
    issuePath,
    api: {
      async request(path: string, options?: unknown) {
        expect(options, "Admission must not publish").toBeUndefined();
        return routes[path]?.() ?? Promise.reject(new Error(`Unexpected request: ${path}`));
      },
      async paginate(path: string) {
        expect(path).toBe(`${issuePath}/comments`);
        return comments;
      },
    },
  };
  return {
    state,
    statuses,
    dependency,
    combined,
    comments,
    approval,
    targets: { approval, state, pull: state.currentPull, head: state.currentPull.head },
    run: () => revalidatePublishedSecurityClearance(review, statuses, publisher),
  };
}

type Targets = ReturnType<typeof fixture>["targets"];
type Mutation = [string, keyof Targets, Partial<Targets[keyof Targets]>, string?, boolean?];
type Mode = "enforced" | "inactive" | "grandfathered";
type Projection = [Mode, string, string, boolean];
type StatusPatch = Partial<ReturnType<typeof fixture>["combined"]>;

it.each<Projection>([
  ...ciProjections.flatMap<Projection>(([state, description]) => [
    ["enforced", state, description, false],
    ["enforced", state, description, true],
  ]),
  ["inactive", "failure", ciFailure, false],
  ["grandfathered", "failure", ciFailure, false],
])("revalidates %s/%s (%s), approval=%s", async (mode, state, description, required) => {
  const f = fixture(required, state, description);
  f.state.rollout = mode;
  if (mode !== "enforced") {
    f.statuses.splice(0, 2);
  }
  await expect(f.run()).resolves.toEqual({
    rollout: { mode },
    combinedStatusId: 3,
    guardStatusIds: mode === "enforced" ? [1, 2] : [],
    approvals: required
      ? ["openclaw/dependency-review", "openclaw/security-sensitive-review"].map((context) => ({
          context,
          kind: "comment",
          login: "maintainer",
          role: "maintain",
          sha: head,
          url: f.approval.html_url,
        }))
      : [],
  });
  if (required) {
    f.comments.pop();
    await expect(f.run()).rejects.toThrow("approval is no longer current");
  }
});

it.each<Mutation>([
  ["edited", "approval", { updated_at: "2026-09-27T11:31:00Z" }],
  ["revoked", "approval", { body: "Approval withdrawn" }],
  ["role lost", "state", { role: "write" }],
  ["head", "head", { sha: "d".repeat(40) }, "Superseded", true],
  ["rollout", "state", { rollout: "grandfathered" }, "rollout changed", true],
  ["merged", "pull", mergedPull, "eligibility changed", true],
])("refuses %s approval authority", async (_name, target, patch, error, duringRead) => {
  const f = fixture(true);
  const mutate = () => {
    Object.assign(f.targets[target], patch);
  };
  if (duringRead) {
    f.state.afterPermission = mutate;
  } else {
    mutate();
  }
  await expect(f.run()).rejects.toThrow(error ?? "approval is no longer current");
});

it.each<[string, "dependency" | "combined", StatusPatch, ("missing" | "duplicate")?]>([
  ["missing guard", "dependency", {}, "missing"],
  ["failed guard", "dependency", { state: "failure" }],
  ["pending guard", "dependency", { state: "pending" }],
  ["duplicate guard", "dependency", {}, "duplicate"],
  ["stale guard", "dependency", { created_at: "2026-09-27T11:59:00Z" }],
  ["unknown decision", "dependency", { description: "PR #7: Someone approved" }],
  ["later decision", "dependency", { updated_at: "2026-09-27T12:00:50Z" }],
  ["foreign publisher", "combined", { target_url: publisher.url + "1" }],
  ["foreign creator", "combined", { creator: { login: "another-bot", type: "Bot" } }],
  ["stale projection", "combined", { created_at: "2026-09-27T11:59:00Z" }],
  ["foreign PR", "combined", { description: `PR #8: ${ciFailure}` }],
  ["security veto", "combined", securityVeto],
  [
    "security pending",
    "combined",
    { state: "pending", description: "PR #7: CI and security review have not completed" },
  ],
])("refuses %s evidence", async (_name, target, patch, count) => {
  const f = fixture();
  Object.assign(f[target], patch);
  if (count === "missing") {
    f.statuses.shift();
  } else if (count === "duplicate") {
    f.statuses.push({ ...f.dependency, id: 4 });
  }
  await expect(f.run()).rejects.toThrow(/Published security clearance/);
});

it("does not discard a contradictory fresh guard failure during an exempt rollout", async () => {
  const f = fixture();
  f.state.rollout = "inactive";
  f.dependency.state = "failure";
  await expect(f.run()).rejects.toThrow("unsuccessful openclaw/dependency-review");
});
