import { describe, expect, it } from "vitest";
import { revalidatePublishedSecurityClearance } from "../../scripts/github/guard-review.mjs";

const head = "a".repeat(40);
const rolloutCommit = "b".repeat(40);
const publisher = {
  url: "https://github.com/openclaw/openclaw/actions/runs/100",
  startedAt: "2026-09-27T12:00:00Z",
  completedAt: "2026-09-27T12:01:00Z",
};

function fixture() {
  const pullRequest = {
    number: 7,
    state: "open",
    draft: false,
    maintainer_can_modify: true,
    created_at: "2026-09-01T00:00:00Z",
    user: { id: 1, login: "contributor", type: "User" },
    changed_files: 2,
    head: { sha: head, ref: "change", repo: { id: 2 } },
    base: { ref: "main", repo: { id: 1 } },
  };
  const state = {
    currentPull: structuredClone(pullRequest),
    rollout: "enforced" as "enforced" | "grandfathered" | "inactive",
    role: "maintain",
    afterPermission: () => {},
  };
  const notice = (marker: string) => ({
    user: { id: 3, login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n<!-- openclaw:approval-request ${JSON.stringify({ head, base: "main", requestedAt: "2026-09-27T11:00:00Z" })} -->`,
    created_at: "2026-09-27T11:00:00Z",
    updated_at: "2026-09-27T11:00:00Z",
    html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-10",
  });
  const approval = {
    user: { id: 2, login: "maintainer", type: "User" },
    body: "/allow-dependencies-change\n/allow-security-sensitive-change",
    created_at: "2026-09-27T11:30:00Z",
    updated_at: "2026-09-27T11:30:00Z",
    html_url: "https://github.com/openclaw/openclaw/pull/7#issuecomment-11",
  };
  const comments = [
    notice("<!-- openclaw:dependency-graph-guard -->"),
    notice("<!-- openclaw:security-sensitive-guard -->"),
    approval,
  ];
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
    "No dependency changes require review.",
  );
  const sensitive = status(2, "openclaw/security-sensitive-review", "No sensitive product changes");
  const combined = status(
    3,
    "openclaw/ci-gate",
    "CI must complete successfully; review updates automatically",
    "failure",
  );
  const statuses = [dependency, sensitive, combined];
  const review = {
    owner: "openclaw",
    repo: "openclaw",
    pullRequest,
    pullPath: "/repos/openclaw/openclaw/pulls/7",
    issuePath: "/repos/openclaw/openclaw/issues/7",
    api: {
      async request(path: string, options?: unknown) {
        if (options) {
          throw new Error("Admission must not publish");
        }
        if (path === "/repos/openclaw/openclaw/pulls/7") {
          return state.currentPull;
        }
        if (path === "/repos/openclaw/openclaw/pulls/152415") {
          return {
            number: 152415,
            state: state.rollout === "inactive" ? "open" : "closed",
            merged: state.rollout !== "inactive",
            merged_at: state.rollout === "inactive" ? null : "2026-09-19T00:00:00Z",
            merge_commit_sha: rolloutCommit,
            base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
          };
        }
        if (
          path === `/repos/openclaw/openclaw/compare/${rolloutCommit}...${head}?per_page=1&page=2`
        ) {
          return {
            base_commit: { sha: rolloutCommit },
            merge_base_commit: {
              sha: state.rollout === "enforced" ? rolloutCommit : "c".repeat(40),
            },
            status: state.rollout === "enforced" ? "ahead" : "diverged",
          };
        }
        if (path === "/repos/openclaw/openclaw/collaborators/contributor/permission") {
          return { role_name: "write" };
        }
        if (path === "/repos/openclaw/openclaw/collaborators/maintainer/permission") {
          state.afterPermission();
          return { role_name: state.role };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
      async paginate(path: string) {
        if (path !== "/repos/openclaw/openclaw/issues/7/comments") {
          throw new Error(`Unexpected pagination: ${path}`);
        }
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
    requireApproval() {
      dependency.description = "PR #7: Dependency review requirements satisfied.";
      sensitive.description = "PR #7: Sensitive changes have maintainer authority";
    },
    run: () => revalidatePublishedSecurityClearance(review, statuses, publisher),
  };
}

describe("published security clearance admission", () => {
  it.each([
    ["failure", "CI must complete successfully; review updates automatically"],
    ["success", "CI and applicable security review requirements passed"],
    ["pending", "Waiting for CI; review updates automatically"],
  ])(
    "admits the CI %s projection after clear guard decisions without requiring a maintainer",
    async (state, description) => {
      const f = fixture();
      f.combined.state = state;
      f.combined.description = `PR #7: ${description}`;
      f.comments.length = 0;
      f.state.role = "write";
      await expect(f.run()).resolves.toEqual({
        rollout: { mode: "enforced" },
        combinedStatusId: 3,
        guardStatusIds: [1, 2],
        approvals: [],
      });
    },
  );

  it.each([
    ["success", "CI and applicable security review requirements passed"],
    ["pending", "Waiting for CI; review updates automatically"],
  ])("revalidates approval behind a published %s projection", async (state, description) => {
    const f = fixture();
    f.requireApproval();
    f.combined.state = state;
    f.combined.description = `PR #7: ${description}`;
    await expect(f.run()).resolves.toMatchObject({ combinedStatusId: 3 });
    f.comments.pop();
    await expect(f.run()).rejects.toThrow("approval is no longer current");
  });

  it("reuses real current approval commands for both approval-dependent decisions", async () => {
    const f = fixture();
    f.requireApproval();
    const result = await f.run();
    expect(result.approvals).toEqual([
      {
        context: "openclaw/dependency-review",
        kind: "comment",
        login: "maintainer",
        role: "maintain",
        sha: head,
        url: f.approval.html_url,
      },
      {
        context: "openclaw/security-sensitive-review",
        kind: "comment",
        login: "maintainer",
        role: "maintain",
        sha: head,
        url: f.approval.html_url,
      },
    ]);
  });

  it.each(["deleted", "edited", "revoked", "role lost"])(
    "refuses %s approval despite green published guards",
    async (change) => {
      const f = fixture();
      f.requireApproval();
      if (change === "deleted") {
        f.comments.pop();
      }
      if (change === "edited") {
        f.approval.updated_at = "2026-09-27T11:31:00Z";
      }
      if (change === "revoked") {
        f.approval.body = "Approval withdrawn";
      }
      if (change === "role lost") {
        f.state.role = "write";
      }
      await expect(f.run()).rejects.toThrow("approval is no longer current");
    },
  );

  it.each(["head", "rollout", "merged"])(
    "refuses %s changes while reading approval authority",
    async (change) => {
      const f = fixture();
      f.requireApproval();
      f.state.afterPermission = () => {
        if (change === "head") {
          f.state.currentPull.head.sha = "d".repeat(40);
        } else if (change === "merged") {
          Object.assign(f.state.currentPull, {
            state: "closed",
            merged: true,
            maintainer_can_modify: false,
          });
        } else {
          f.state.rollout = "grandfathered";
        }
      };
      await expect(f.run()).rejects.toThrow(
        change === "head"
          ? "Superseded"
          : change === "merged"
            ? "eligibility changed"
            : "rollout changed",
      );
    },
  );

  it.each([
    "missing",
    "failure",
    "pending",
    "duplicate",
    "stale",
    "unknown description",
    "later decision",
  ])("refuses %s guard evidence", async (change) => {
    const f = fixture();
    if (change === "missing") {
      f.statuses.shift();
    }
    if (change === "failure" || change === "pending") {
      f.dependency.state = change;
    }
    if (change === "duplicate") {
      f.statuses.push({ ...f.dependency, id: 4 });
    }
    if (change === "stale") {
      f.dependency.created_at = "2026-09-27T11:59:00Z";
    }
    if (change === "unknown description") {
      f.dependency.description = "PR #7: Someone approved";
    }
    if (change === "later decision") {
      f.dependency.updated_at = "2026-09-27T12:00:50Z";
    }
    await expect(f.run()).rejects.toThrow(/Published security clearance/);
  });

  it.each(["publisher", "creator", "time", "PR", "security veto", "security pending"])(
    "refuses foreign or ambiguous combined evidence: %s",
    async (change) => {
      const f = fixture();
      const combined = f.combined;
      if (change === "publisher") {
        combined.target_url += "1";
      }
      if (change === "creator") {
        combined.creator.login = "another-bot";
      }
      if (change === "time") {
        combined.created_at = "2026-09-27T11:59:00Z";
      }
      if (change === "PR") {
        combined.description = combined.description.replace("#7:", "#8:");
      }
      if (change === "security veto") {
        combined.description = "PR #7: A maintainer must approve the current PR revision";
      }
      if (change === "security pending") {
        combined.state = "pending";
        combined.description = "PR #7: CI and security review have not completed";
      }
      await expect(f.run()).rejects.toThrow(/Published security clearance/);
    },
  );

  it.each(["inactive", "grandfathered"] as const)(
    "uses the actual %s rollout without requiring unpublished standalone statuses",
    async (mode) => {
      const f = fixture();
      f.state.rollout = mode;
      f.statuses.splice(0, 2);
      await expect(f.run()).resolves.toEqual({
        rollout: { mode },
        combinedStatusId: 3,
        guardStatusIds: [],
        approvals: [],
      });
    },
  );

  it("does not discard a contradictory fresh guard failure during an exempt rollout", async () => {
    const f = fixture();
    f.state.rollout = "inactive";
    f.dependency.state = "failure";
    await expect(f.run()).rejects.toThrow("unsuccessful openclaw/dependency-review");
  });
});
