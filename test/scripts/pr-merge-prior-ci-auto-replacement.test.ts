import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function cancelledAutoReplacement(
  options: { cancellation?: "confirmed" | "missing" | "uncertain"; replace?: boolean } = {},
) {
  const cancellation = options.cancellation ?? "confirmed";
  const initial = fixture();
  initial.save({
    ...initial.state(),
    mode: "pending",
    pr: { ...initial.state().pr, mergeStateStatus: "BLOCKED" },
  });
  const accepted = initial.run(true);
  expect(accepted.status, accepted.output).toBe(0);
  const originalOid = initial.git(["rev-parse", outcomeRef]);
  const originalRecord = initial.record();
  expect(originalRecord).toMatchObject({ phase: "intent", route: "auto", accepted: true });
  const captures = initial.captures();
  expect(captures).toHaveLength(1);

  if (cancellation !== "missing") {
    initial.save({
      ...initial.state(),
      cancellation: cancellation === "uncertain" ? "rejected" : "success",
    });
    const cancelled = initial.cancel(originalOid);
    expect(cancelled.status, cancelled.output).toBe(cancellation === "confirmed" ? 0 : 1);
    if (cancellation === "uncertain") {
      expect(initial.recover()).toBe(true);
    }
  }
  const retiredOid = initial.git(["rev-parse", outcomeRef]);
  const retiredRecord = initial.record();
  expect(retiredRecord).toMatchObject({
    phase: "intent",
    route: "auto",
    accepted: true,
    ...(cancellation === "missing"
      ? {}
      : {
          cancellation: {
            state: cancellation === "confirmed" ? "confirmed" : "requested",
            outcome: originalOid,
          },
        }),
  });
  if (cancellation === "missing") {
    expect(retiredRecord).not.toHaveProperty("cancellation");
  }
  // Absence on the provider alone must not substitute for confirmed retirement evidence.
  if (cancellation !== "confirmed") {
    initial.save({ ...initial.state(), pr: { ...initial.state().pr, autoMergeRequest: null } });
  }
  expect(initial.state().pr.autoMergeRequest).toBeNull();

  const replacement = options.replace === false ? initial.head : initial.replacePreparedHead();
  expect(replacement === originalRecord.head).toBe(options.replace === false);
  const main = initial.git(["--git-dir=" + initial.remote, "rev-parse", "refs/heads/main"]);
  const f = preExistingCandidate(undefined, { ...initial, head: replacement, base: main });
  f.save({ ...f.state(), mode: "success" });
  expect(JSON.parse(readFileSync(join(f.worktree, ".local/review.json"), "utf8"))).toMatchObject({
    tests: { result: "fail", preExistingCi: { head: replacement, runId: 501, runAttempt: 2 } },
  });
  return { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement, captures };
}

describePosix("prior-CI admin recovery after auto cancellation", () => {
  it.each([
    ["retained head", false],
    ["replacement head", true],
  ] as const)(
    "lands the %s after confirmed cancellation and preserves the original history",
    (_label, replace) => {
      const { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement, captures } =
        cancelledAutoReplacement({ replace });
      if (!replace) {
        f.save({ ...f.state(), observations: [{}, {}, {}, {}, { advanceMain: true }] });
      }
      const recovered = f.adminPriorCi(f.path, true, retiredOid, replacement);
      expect(recovered.status, recovered.output).toBe(0);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
      if (!replace) {
        expect(f.state().mainAdvances).toHaveLength(1);
        expect(recovered.output).toContain("Requalifying prior-CI admission after main");
      }
      expect(f.state().restMergePayload).toMatchObject({
        sha: replacement,
        merge_method: "squash",
      });
      expect(f.record()).toMatchObject({
        phase: "complete",
        route: "admin",
        accepted: true,
        head: replacement,
        priorCiAdmin: { head: replacement, runId: 501, runAttempt: 2, dispatchTransport: "rest" },
        recovery: {
          outcome: retiredOid,
          attempt: originalRecord.attempt,
          replacementHead: replacement,
        },
      });
      expect(f.record().recovery).not.toHaveProperty("providerRejection");
      expect(f.record().recovery).not.toHaveProperty("preDispatchRefusal");
      const successorIntent = f
        .git(["rev-list", "--ancestry-path", "--reverse", `${retiredOid}..${outcomeRef}`])
        .split("\n")[0]!;
      expect(JSON.parse(f.git(["show", `${successorIntent}:outcome.json`]))).toMatchObject({
        phase: "intent",
        accepted: false,
        head: replacement,
      });
      for (const [oid, record] of [
        [originalOid, originalRecord],
        [retiredOid, retiredRecord],
      ] as const) {
        expect(JSON.parse(f.git(["show", `${oid}:outcome.json`]))).toEqual(record);
        expect(f.git(["merge-base", "--is-ancestor", oid, outcomeRef])).toBe("");
      }
      for (const [name, bytes] of captures) {
        expect(f.git(["rev-parse", `${successorIntent}:${name}`])).toBe(
          f.git(["hash-object", "--stdin"], bytes),
        );
      }
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each([
    ["missing cancellation", "operator admin recovery requires"],
    ["uncertain cancellation", "operator admin recovery requires"],
    ["missing replacement", "explicit selected head"],
    ["wrong replacement", "recovery requires matching PR"],
    ["stale pending stamp", "valid gate bindings"],
    ["renewed auto request", "no existing auto/queue request"],
    ["stale outcome", "operator admin recovery requires"],
    ["revoked admin", "active organization admin"],
    ["revoked admin after materialization", "active organization admin"],
    ["required review", "current enforced reviews must be satisfied"],
    ["failed security", "unsuccessful openclaw/security-sensitive-review"],
    ["new CI attempt", "newer or running CI attempt"],
    ["original CI head", "selected CI attempt must have the expected conclusion"],
  ] as const)("refuses %s without another merge request", (fault, diagnostic) => {
    const { f, originalOid, originalRecord, retiredOid, replacement } = cancelledAutoReplacement({
      cancellation:
        fault === "missing cancellation"
          ? "missing"
          : fault === "uncertain cancellation"
            ? "uncertain"
            : "confirmed",
      replace: fault !== "missing replacement",
    });
    const state = f.state();
    if (fault === "stale pending stamp") {
      writeFileSync(
        join(f.worktree, ".local/gates.env"),
        `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${originalRecord.head}\n`,
      );
    }
    if (fault === "renewed auto request") {
      state.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
    }
    if (fault === "revoked admin") {
      state.priorCi.membership = "member";
    }
    if (fault === "revoked admin after materialization") {
      state.priorCi.revokeAdminOnMainFetch = true;
      state.observations = [{}, {}, {}, {}, { advanceMain: true }];
    }
    if (fault === "required review") {
      state.priorCi.reviewDecision = "REVIEW_REQUIRED";
    }
    if (fault === "failed security") {
      state.priorCi.security.fault = "failed-guard";
    }
    if (fault === "new CI attempt") {
      state.priorCi.latestAttempt = 3;
    }
    if (fault === "original CI head") {
      state.priorCi.runHead = originalRecord.head;
    }
    f.save(state);
    const result = f.adminPriorCi(
      f.path,
      true,
      fault === "stale outcome" ? originalOid : retiredOid,
      fault === "missing replacement" ? "" : fault === "wrong replacement" ? f.base : replacement,
    );
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(diagnostic);
    if (fault === "revoked admin after materialization") {
      expect(result.error, result.output).toBeUndefined();
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(true);
      expect(f.state().mainAdvances).toHaveLength(1);
    }
    expect(f.state()).toMatchObject({
      mutations: 1,
      cancellations: fault === "missing cancellation" ? 0 : 1,
      posts: 0,
      restMergePayload: null,
      pr: { state: "OPEN", mergeCommit: null },
    });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it.each([
    ["missing cancellation", "operator admin recovery requires"],
    ["uncertain cancellation", "operator admin recovery requires"],
    ["renewed auto request", "no existing auto/queue request"],
    ["queue enrollment", "no existing auto/queue request"],
    ["stale prepare", "recovery requires matching PR"],
    ["revoked admin", "active organization admin"],
    ["required review", "current enforced reviews must be satisfied"],
    ["failed security", "unsuccessful openclaw/security-sensitive-review"],
    ["new CI attempt", "newer or running CI attempt"],
    ["missing attribution", "every failed job must have exactly one"],
  ] as const)("refuses same-head %s before another request", (fault, diagnostic) => {
    const { f, retiredOid } = cancelledAutoReplacement({
      replace: false,
      cancellation:
        fault === "missing cancellation"
          ? "missing"
          : fault === "uncertain cancellation"
            ? "uncertain"
            : "confirmed",
    });
    const state = f.state();
    if (fault === "renewed auto request") {
      state.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
    }
    if (fault === "queue enrollment") {
      state.pr.isInMergeQueue = true;
      state.pr.isMergeQueueEnabled = true;
    }
    if (fault === "stale prepare") {
      writeFileSync(
        join(f.worktree, ".local/gates.env"),
        `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.base}\n`,
      );
    }
    if (fault === "revoked admin") {
      state.priorCi.membership = "member";
    }
    if (fault === "required review") {
      state.priorCi.reviewDecision = "REVIEW_REQUIRED";
    }
    if (fault === "failed security") {
      state.priorCi.security.fault = "failed-guard";
    }
    if (fault === "new CI attempt") {
      state.priorCi.latestAttempt = 3;
    }
    if (fault === "missing attribution") {
      writeFileSync(f.path, JSON.stringify({ ...f.evidence, failures: [] }));
    }
    f.save(state);
    const result = f.adminPriorCi(f.path, true, retiredOid, f.head);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(diagnostic);
    expect(f.state()).toMatchObject({ mutations: 1, restMergePayload: null, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it("does not infer recovery permission from admin evidence on an ordinary resume", () => {
    const { f, retiredOid } = cancelledAutoReplacement();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("PR identity/head/base drift from the retained attempt");
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it.each([false, true])(
    "refuses captures changed during final admission (replace=%s)",
    (replace) => {
      const { f, retiredOid, replacement } = cancelledAutoReplacement({ replace });
      f.save({
        ...f.state(),
        observationReads: 0,
        observations: [{}, {}, {}, {}, { tamperProviderCapture: true }],
      });
      const result = f.adminPriorCi(f.path, true, retiredOid, replacement);
      expect(result.status, result.output).toBe(1);
      expect(f.state().providerCaptureTampered).toBe(true);
      expect(result.output).toContain("recovery artifacts changed during admission");
      expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
      expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
    },
  );

  it.each([false, true])(
    "preserves the recovery CAS successor without dispatch (replace=%s)",
    (replace) => {
      const { f, retiredOid, replacement } = cancelledAutoReplacement({ replace });
      f.save({ ...f.state(), crash: "successor" });
      const result = f.adminPriorCi(f.path, true, retiredOid, replacement);
      expect(result.status, result.output).toBe(1);
      expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
      expect(result.output).toContain("outcome owner changed");
      expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
      expect(JSON.parse(f.git(["show", `${retiredOid}:outcome.json`]))).toMatchObject({
        accepted: true,
        cancellation: { state: "confirmed" },
      });
    },
  );
});
