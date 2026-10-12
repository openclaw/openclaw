import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const uncertainGatewayResponse = '{\n  "message": "Server Error"\n}\ngh: Server Error (HTTP 502)\n';

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
      expect(initial.recover()).toBe(false);
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

function staleAdminReplacement() {
  const cancelled = cancelledAutoReplacement({ replace: false });
  const { f, retiredOid } = cancelled;
  f.save({ ...f.state(), restMergeRefusal: uncertainGatewayResponse });
  const attempted = f.adminPriorCi(f.path, true, retiredOid, f.head);
  expect(attempted.status, attempted.output).toBe(1);
  const adminOid = f.git(["rev-parse", outcomeRef]);
  const adminRecord = f.record();
  expect(adminRecord).toMatchObject({
    phase: "intent",
    route: "admin",
    accepted: false,
    head: f.head,
    recovery: { outcome: retiredOid, replacementHead: f.head },
  });
  const adminCapture = `merge-output.${adminRecord.attempt}.log`;
  expect(readFileSync(join(f.worktree, ".local", adminCapture), "utf8")).toBe(
    uncertainGatewayResponse,
  );
  expect(f.recover()).toBe(false);

  const replacement = f.replacePreparedHead();
  writeFileSync(
    join(f.worktree, ".local/gates.env"),
    `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${replacement}\n`,
  );
  f.save({
    ...f.state(),
    mode: "pending",
    gates: "pending",
    requiredCheckName: "openclaw/ci-gate",
    restContexts: ["openclaw/ci-gate", "Security Review"],
    restMergeRefusal: "",
    pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
  });
  return {
    ...cancelled,
    f: { ...f, head: replacement },
    adminOid,
    adminRecord,
    adminCapture,
    replacement,
  };
}

function recoveredStaleAdminAuto() {
  const setup = staleAdminReplacement();
  const recovered = setup.f.run(true, setup.f.repo, "squash", setup.adminOid, setup.replacement);
  expect(recovered.status, recovered.output).toBe(0);
  const recoveredOid = setup.f.git(["rev-parse", outcomeRef]);
  const recoveredRecord = setup.f.record();
  expect(recoveredRecord).toMatchObject({
    phase: "intent",
    route: "auto",
    accepted: true,
    recovery: { outcome: setup.adminOid },
  });
  return { ...setup, recoveredOid, recoveredRecord };
}

function rewriteRecord(
  f: ReturnType<typeof staleAdminReplacement>["f"],
  changes: Record<string, unknown>,
) {
  const previous = f.git(["rev-parse", outcomeRef]);
  const blob = f.git(
    ["hash-object", "-w", "--stdin"],
    JSON.stringify({ ...f.record(), ...changes }),
  );
  const entries = f
    .git(["ls-tree", previous])
    .split("\n")
    .filter((entry) => !entry.endsWith("\toutcome.json"));
  const tree = f.git(["mktree"], [...entries, `100644 blob ${blob}\toutcome.json`, ""].join("\n"));
  const rewritten = f.commit(tree, f.git(["show", "-s", "--format=%P", previous]).split(" "));
  f.git(["update-ref", outcomeRef, rewritten, previous]);
  return rewritten;
}

describePosix("prior-CI admin recovery after auto cancellation", () => {
  it("retires an uncertain stale-head admin dispatch and preserves the complete capture chain", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord, adminCapture, replacement } =
      staleAdminReplacement();
    const captures = f.captures();
    expect(captures).toHaveLength(2);

    const recovered = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(recovered.status, recovered.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.state().pr.autoMergeRequest).toEqual({ mergeMethod: "SQUASH" });
    expect(f.record(), recovered.output).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: true,
      head: replacement,
      recovery: {
        outcome: adminOid,
        attempt: adminRecord.attempt,
        replacementHead: replacement,
        staleHeadRetirement: {
          kind: "github-rest-sha-head-fenced",
          capture: adminCapture,
        },
      },
    });
    expect(Object.keys(f.record().recovery.staleHeadRetirement.files).toSorted()).toEqual(
      captures.map(([name]) => name).toSorted(),
    );
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    const recoveryCaptures = f.captures();
    expect(recoveryCaptures).toHaveLength(3);
    expect(recoveryCaptures.map(([name]) => name)).toContain(
      `merge-output.${recoveredRecord.attempt}.log`,
    );
    for (const oid of [originalOid, retiredOid, adminOid]) {
      expect(f.git(["merge-base", "--is-ancestor", oid, outcomeRef])).toBe("");
    }
    for (const [name, bytes] of captures) {
      expect(f.git(["rev-parse", `${outcomeRef}:${name}`])).toBe(
        f.git(["hash-object", "--stdin"], bytes),
      );
    }

    f.save({ ...f.state(), cancellation: "success" });
    const cancelled = f.cancel(recoveredOid);
    expect(cancelled.status, cancelled.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 2, posts: 0 });
    expect(f.record()).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: true,
      cancellation: { state: "confirmed", outcome: recoveredOid },
    });
    const cancelledOid = f.git(["rev-parse", outcomeRef]);
    for (const oid of [originalOid, retiredOid, adminOid, recoveredOid]) {
      expect(f.git(["merge-base", "--is-ancestor", oid, cancelledOid])).toBe("");
    }
    for (const [name, bytes] of recoveryCaptures) {
      expect(f.git(["rev-parse", `${cancelledOid}:${name}`])).toBe(
        f.git(["hash-object", "--stdin"], bytes),
      );
    }

    const nextReplacement = f.replacePreparedHead();
    f.save({
      ...f.state(),
      mode: "success",
      gates: "pass",
      pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
    });
    const resumed = f.run(false, f.repo, "squash", cancelledOid, nextReplacement);
    expect(resumed.status, resumed.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 4, cancellations: 2, posts: 1 });
    expect(f.record()).toMatchObject({
      phase: "complete",
      head: nextReplacement,
      recovery: { outcome: cancelledOid, replacementHead: nextReplacement },
    });
    const subsequentIntent = f
      .git(["rev-list", "--ancestry-path", "--reverse", `${cancelledOid}..${outcomeRef}`])
      .split("\n")[0]!;
    for (const oid of [originalOid, retiredOid, adminOid, recoveredOid, cancelledOid]) {
      expect(f.git(["merge-base", "--is-ancestor", oid, outcomeRef])).toBe("");
    }
    for (const [name, bytes] of recoveryCaptures) {
      expect(f.git(["rev-parse", `${subsequentIntent}:${name}`])).toBe(
        f.git(["hash-object", "--stdin"], bytes),
      );
      expect(f.git(["rev-parse", `${outcomeRef}:${name}`])).toBe(
        f.git(["hash-object", "--stdin"], bytes),
      );
    }
    expect(existsSync(f.worktree)).toBe(false);
  });

  it("cancels an uncertain recovered auto request and retains its current attempt capture", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    f.save({ ...f.state(), mode: "pending-error" });

    const attempted = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(attempted.status, attempted.output).toBe(1);
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    expect(recoveredRecord).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: false,
      recovery: { outcome: adminOid },
    });
    const attemptCapture = `merge-output.${recoveredRecord.attempt}.log`;
    const attemptBytes = readFileSync(join(f.worktree, ".local", attemptCapture), "utf8");
    expect(() => f.git(["cat-file", "-e", `${recoveredOid}:${attemptCapture}`])).toThrow();
    expect(f.recover()).toBe(false);

    f.save({ ...f.state(), cancellation: "success" });
    const cancelled = f.cancel(recoveredOid);
    expect(cancelled.status, cancelled.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 2, posts: 0 });
    expect(f.record()).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: false,
      cancellation: { state: "confirmed", outcome: recoveredOid },
    });
    expect(f.git(["merge-base", "--is-ancestor", recoveredOid, outcomeRef])).toBe("");
    expect(f.git(["rev-parse", `${outcomeRef}:${attemptCapture}`])).toBe(
      f.git(["hash-object", "--stdin"], attemptBytes),
    );
  });

  it("reconciles an interrupted recovered merge from the canonical checkout", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    f.save({ ...f.state(), mode: "success", crash: "dispatch" });

    const attempted = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(attempted.status, attempted.output).not.toBe(0);
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    expect(recoveredRecord).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: false,
      recovery: { outcome: adminOid },
    });
    const attemptCapture = `merge-output.${recoveredRecord.attempt}.log`;
    const attemptBytes = readFileSync(join(f.worktree, ".local", attemptCapture), "utf8");
    expect(() => f.git(["cat-file", "-e", `${recoveredOid}:${attemptCapture}`])).toThrow();
    expect(f.recover()).toBe(true);
    f.save({ ...f.state(), crash: "" });
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "refs/heads/main"]);

    const reconciled = f.run();
    expect(reconciled.status, reconciled.output).toBe(0);
    expect(f.record()).toMatchObject({
      phase: "merged",
      route: "auto",
      accepted: false,
      recovery: { outcome: adminOid },
      landed,
    });
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.git(["merge-base", "--is-ancestor", recoveredOid, outcomeRef])).toBe("");
    expect(f.git(["rev-parse", `${outcomeRef}:${attemptCapture}`])).toBe(
      f.git(["hash-object", "--stdin"], attemptBytes),
    );
  });

  it.each(["a changed successor capture", "an extra capture"])(
    "refuses cancellation with %s",
    (fault) => {
      const { f, recoveredOid, recoveredRecord } = recoveredStaleAdminAuto();
      if (fault === "a changed successor capture") {
        writeFileSync(
          join(f.worktree, ".local", `merge-output.${recoveredRecord.attempt}.log`),
          "changed successor capture\n",
        );
      } else {
        writeFileSync(join(f.worktree, ".local/merge-output.extra.log"), "extra\n");
      }
      f.save({ ...f.state(), cancellation: "success" });

      const cancelled = f.cancel(recoveredOid);
      expect(cancelled.status, cancelled.output).toBe(1);
      expect(cancelled.output).toContain(
        fault === "a changed successor capture"
          ? "merge capture changed before retention"
          : "merge capture set changed before retention",
      );
      expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(recoveredOid);
    },
  );

  it.each(["a changed successor capture", "an extra capture"])(
    "refuses subsequent recovery with %s",
    (fault) => {
      const { f, recoveredOid, recoveredRecord } = recoveredStaleAdminAuto();
      f.save({ ...f.state(), cancellation: "success" });
      const cancelled = f.cancel(recoveredOid);
      expect(cancelled.status, cancelled.output).toBe(0);
      const cancelledOid = f.git(["rev-parse", outcomeRef]);
      const nextReplacement = f.replacePreparedHead();
      if (fault === "a changed successor capture") {
        writeFileSync(
          join(f.worktree, ".local", `merge-output.${recoveredRecord.attempt}.log`),
          "changed successor capture\n",
        );
      } else {
        writeFileSync(join(f.worktree, ".local/merge-output.extra.log"), "extra\n");
      }
      f.save({
        ...f.state(),
        mode: "success",
        gates: "pass",
        pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
      });

      const resumed = f.run(false, f.repo, "squash", cancelledOid, nextReplacement);
      expect(resumed.status, resumed.output).toBe(1);
      expect(resumed.output).toContain(
        fault === "a changed successor capture"
          ? "merge capture changed before retention"
          : "merge capture set changed before retention",
      );
      expect(f.state()).toMatchObject({ mutations: 3, cancellations: 2, posts: 0 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(cancelledOid);
    },
  );

  it.each(["same head", "accepted admin", "stale outcome", "route mismatch", "method mismatch"])(
    "refuses stale-head auto recovery with %s",
    (fault) => {
      const { f, retiredOid, adminOid, adminRecord, replacement } = staleAdminReplacement();
      let outcome = adminOid;
      let selectedHead = replacement;
      if (fault === "same head") {
        selectedHead = adminRecord.head;
      } else if (fault === "accepted admin") {
        outcome = rewriteRecord(f, { accepted: true });
      } else if (fault === "stale outcome") {
        outcome = retiredOid;
      } else if (fault === "route mismatch") {
        outcome = rewriteRecord(f, { route: "immediate", priorCiAdmin: undefined });
      } else if (fault === "method mismatch") {
        outcome = rewriteRecord(f, { method: "merge" });
      }
      const result = f.run(true, f.repo, "squash", outcome, selectedHead);
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.git(["rev-parse", outcomeRef])).toBe(fault === "stale outcome" ? adminOid : outcome);
    },
  );

  it.each(["missing", "symlink", "extra"])(
    "refuses stale-head auto recovery with %s captures",
    (fault) => {
      const { f, adminOid, adminCapture, replacement } = staleAdminReplacement();
      const capturePath = join(f.worktree, ".local", adminCapture);
      if (fault === "missing") {
        rmSync(capturePath);
      } else if (fault === "symlink") {
        const target = join(f.root, "admin-502.txt");
        writeFileSync(target, uncertainGatewayResponse);
        rmSync(capturePath);
        symlinkSync(target, capturePath);
      } else {
        writeFileSync(join(f.worktree, ".local/merge-output.extra.log"), "extra\n");
      }
      const result = f.run(true, f.repo, "squash", adminOid, replacement);
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    },
  );

  it("refuses stale-head capture bytes changed during final admission", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    f.save({
      ...f.state(),
      observationReads: 0,
      observations: [{ tamperProviderCapture: true }],
    });
    const result = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(result.status, result.output).toBe(1);
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(result.output).toContain("stale-head retirement evidence changed during admission");
    expect(f.state().pr.autoMergeRequest).toBeNull();
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
  });

  it.each([
    "closed",
    "merged",
    "current-head drift",
    "stale gate binding",
    "failed required check",
    "missing ClawSweeper review",
    "invalid current review",
  ])("revalidates %s before stale-head auto recovery", (fault) => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    const state = f.state();
    if (fault === "closed") {
      state.pr.state = "CLOSED";
    } else if (fault === "merged") {
      state.pr.state = "MERGED";
      state.pr.mergeCommit = { oid: f.base };
    } else if (fault === "current-head drift") {
      state.pr.headRefOid = f.base;
    } else if (fault === "stale gate binding") {
      writeFileSync(
        join(f.worktree, ".local/gates.env"),
        `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.base}\n`,
      );
    } else if (fault === "failed required check") {
      state.gates = "fail";
    } else if (fault === "missing ClawSweeper review") {
      state.issueComments = [];
    } else {
      const reviewPath = join(f.worktree, ".local/review.json");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      review.recommendation = "NEEDS WORK";
      writeFileSync(reviewPath, JSON.stringify(review));
    }
    f.save(state);
    const result = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(result.status, result.output).toBe(1);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
    expect(f.state().pr.autoMergeRequest).toBeNull();
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
  });

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
    ["queue enrollment", "no existing auto/queue request"],
    ["missing attribution", "every failed job must have exactly one"],
  ] as const)("refuses same-head %s before another request", (fault, diagnostic) => {
    const { f, retiredOid } = cancelledAutoReplacement({
      replace: false,
    });
    const state = f.state();
    if (fault === "queue enrollment") {
      state.pr.isInMergeQueue = true;
      state.pr.isMergeQueueEnabled = true;
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

  it.each([true])("refuses captures changed during final admission (replace=%s)", (replace) => {
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
  });

  it.each([true])(
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
