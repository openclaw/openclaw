import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { expectExit, expectPriorCiRefusal } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, describePosix, outcomeRef } = createMergeOutcomeFixtureHarness();
const { artifactBuildCandidate } = createPriorCiCandidateFactory(fixture);

describePosix("artifact-build failure with successful primary CI", () => {
  it.each(["qualified", "revoked membership", "revoked bypass"])(
    "revalidates the %s delegated writer at the merge I/O boundary",
    (authority) => {
      const f = artifactBuildCandidate();
      const state = f.state();
      state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
      state.priorCi.membership = "member";
      state.priorCi.rulesetBypass = "always";
      // merge_verify reads authority twice; final merge_run qualification must start
      // authorized and lose membership/bypass only at its last writer read.
      state.priorCi.revokeMembershipAfterReads = authority === "revoked membership" ? 3 : 0;
      state.priorCi.revokeRulesetAfterRead = authority === "revoked bypass";
      state.priorCi.revokeRulesetAfterReads = 3;
      f.save(state);

      // Run the real shell owner and verifier; only GitHub's boundary is synthetic.
      const result = f.adminPriorCi(f.path);
      const final = f.state();
      const dispatches = final.calls.filter(
        (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
      );
      const dispatch = final.calls.indexOf(dispatches[0]!);
      const reads = dispatch < 0 ? final.calls : final.calls.slice(0, dispatch);
      const finalSecurity = reads.findLastIndex((call) =>
        call.some((arg) => arg.startsWith(`repos/fixture/repo/commits/${f.head}/statuses?`)),
      );
      const finalPolicy = reads.findLastIndex((call) =>
        call.some((arg) => arg.startsWith("repos/fixture/repo/rules/branches/main?")),
      );
      const membership = reads.flatMap((call, index) =>
        call.includes("orgs/fixture/memberships/fixture-operator") ? [index] : [],
      );
      expect(membership).toHaveLength(4);
      expect(finalSecurity).toBeGreaterThan(membership[2]!);
      expect(finalPolicy).toBeGreaterThan(finalSecurity);
      expect(membership[3]).toBeGreaterThan(finalPolicy);
      expect(final.priorCi.membershipReads).toBe(4);
      expect(final.priorCi.rulesetReads).toBe(authority === "revoked membership" ? 3 : 4);
      if (authority !== "revoked membership") {
        expect(
          reads.findLastIndex((call) => call.includes("repos/fixture/repo/rulesets/41")),
        ).toBeGreaterThan(membership[3]!);
      }

      if (authority === "qualified") {
        expectExit(result, 0);
        expect(dispatches).toHaveLength(1);
        expect(final).toMatchObject({
          mutations: 1,
          posts: 1,
          restMergePayload: { sha: f.head, merge_method: "squash" },
        });
        expect(final.comments).toHaveLength(1);
        expect(f.record()).toMatchObject({
          phase: "complete",
          head: f.head,
          priorCiAdmin: {
            primaryCi: { runId: 502, runAttempt: 2 },
            delegation: { kind: "ci-ruleset-bypass", rulesets: [{ id: 41, mode: "always" }] },
          },
        });
      } else {
        expectExit(result, 1);
        expect(result.output).toContain(
          authority === "revoked membership" ? "404" : "live CI-only ruleset bypass",
        );
        expect(dispatches).toEqual([]);
        expect(final).toMatchObject({
          mutations: 0,
          posts: 0,
          comments: [],
          restMergePayload: null,
          graphqlMergePayloads: [],
        });
        expect(f.git(["for-each-ref", "--format=%(refname)", outcomeRef])).toBe("");
        expect(f.captures()).toEqual([]);
      }
      console.info(
        "[artifact-authority-proof]",
        JSON.stringify({
          authority,
          exit: result.status,
          membershipReads: final.priorCi.membershipReads,
          rulesetReads: final.priorCi.rulesetReads,
          membershipHttp404: result.output.includes("HTTP 404"),
          order: {
            initialWriter: membership[2],
            finalSecurity,
            finalPolicy,
            finalWriter: membership[3],
            dispatch,
          },
          puts: dispatches.length,
          headPinned: final.restMergePayload?.sha === f.head,
          method: final.restMergePayload?.merge_method ?? null,
          mutations: final.mutations,
          posts: final.posts,
          outcome: authority === "qualified" ? f.record().phase : "absent",
          deniedCaptures: authority === "qualified" ? null : f.captures().length,
        }),
      );
    },
  );

  it("admits the optional failed attempt without changing the failed review or pending preparation", () => {
    const f = artifactBuildCandidate();
    const review = readFileSync(join(f.worktree, ".local/review.json"), "utf8");
    const gates = readFileSync(join(f.worktree, ".local/gates.env"), "utf8");
    expectExit(f.verifyPriorCi(f.path), 0);
    expect(readFileSync(join(f.worktree, ".local/review.json"), "utf8")).toBe(review);
    expect(readFileSync(join(f.worktree, ".local/gates.env"), "utf8")).toBe(gates);
    expectExit(f.adminPriorCi(f.path), 0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().comments[0]?.body).toContain(
      "Artifact-build failure with successful primary CI",
    );
    expect(f.state().comments[0]?.body).toContain("/actions/runs/502/attempts/2");
    expect(f.record().priorCiAdmin).toMatchObject({
      runId: 501,
      runAttempt: 2,
      primaryCi: { runId: 502, runAttempt: 2 },
      workflowId: 51,
      checkSuiteId: 10,
      failures: [{ jobId: 601 }],
      gateCheckRunId: 1,
    });
  });

  it.each([
    ["primary failed", "current successful primary"],
    ["primary attempt", "current successful primary"],
    ["primary head", "current successful primary"],
    ["primary PR", "current successful primary"],
    ["primary security", "primary CI gate and security-fast"],
    ["required", "must be optional"],
    ["suite", "exact job, suite, workflow"],
    ["new run", "newer artifact-build workflow run"],
  ])("refuses %s before dispatch", (fault, message) => {
    const f = artifactBuildCandidate();
    const state = f.state();
    state.priorCi.artifactFault = fault;
    f.save(state);
    expectPriorCiRefusal(f, message);
  });

  it.each([
    "required check",
    "optional failure",
    "cancelled job",
    "new attempt",
    "security replay",
    "security replay run",
    "workflow input",
  ])("keeps the existing %s boundary", (fault) => {
    const f = artifactBuildCandidate();
    const state = f.state();
    if (fault === "required check" || fault === "optional failure") {
      state.priorCi.nativeChecks = [
        {
          name: "another-check",
          kind: "check",
          required: fault === "required check",
          state: "failure",
        },
      ];
    } else if (fault === "cancelled job") {
      state.priorCi.jobs![1]!.conclusion = "cancelled";
    } else if (fault === "new attempt") {
      state.priorCi.latestAttempt = 3;
    } else if (fault.startsWith("security replay")) {
      state.priorCi.security.fault =
        fault === "security replay" ? "wrong-ci-attempt" : "wrong-ci-run";
    } else {
      f.evidence.failures[0]!.sourcePaths = ["sibling.txt"];
      writeFileSync(f.path, JSON.stringify(f.evidence));
    }
    f.save(state);
    expectPriorCiRefusal(
      f,
      /other failed|cancellation|newer or running|security enforcement|unchanged workflow/,
    );
  });
});
