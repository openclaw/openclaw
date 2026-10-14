import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const refusal = readFileSync(
  new URL("../fixtures/pr-admin-base-modified-405.txt", import.meta.url),
  "utf8",
);
type RecoveryFixture = ReturnType<typeof preExistingCandidate>;

function mergeRequests(f: RecoveryFixture) {
  return f
    .state()
    .calls.filter(
      (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
    );
}

function rejectedAttempt(response = refusal) {
  const f = preExistingCandidate();
  f.save({ ...f.state(), restMergeRefusal: response });
  const result = f.adminPriorCi(f.path);
  expect(result.status, result.output).toBe(1);
  expect(mergeRequests(f)).toHaveLength(1);
  expect(f.state().pr).toMatchObject({ state: "OPEN", mergeCommit: null });
  expect(f.record()).toMatchObject({
    phase: "intent",
    accepted: false,
    route: "admin",
    priorCiAdmin: { dispatchTransport: "rest", head: f.head },
  });
  const oid = f.git(["rev-parse", outcomeRef]);
  const record = f.record();
  const capture = `merge-output.${record.attempt}.log`;
  expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(response);
  expect(f.recover()).toBe(false);
  f.save({ ...f.state(), restMergeRefusal: "" });
  return { f, oid, record, capture };
}

function expectRetainedCapture(f: RecoveryFixture, ref: string, capture: string) {
  // Blob equality checks the original bytes, including the final newline.
  expect(f.git(["rev-parse", `${ref}:${capture}`])).toBe(
    f.git(["hash-object", "--stdin"], refusal),
  );
}

function rewriteRecord(f: RecoveryFixture, changes: Record<string, unknown>) {
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
  const parents = f.git(["show", "-s", "--format=%P", previous]).split(" ");
  const rewritten = f.commit(tree, parents);
  f.git(["update-ref", outcomeRef, rewritten, previous]);
  return rewritten;
}

describePosix("explicit prior-CI provider rejection recovery", () => {
  it("recovers the exact rejected request and retains its intent and bytes through cleanup", () => {
    const { f, oid, record, capture } = rejectedAttempt();
    const ordinary = f.run();
    expect(ordinary.status, ordinary.output).toBe(1);
    expect(mergeRequests(f)).toHaveLength(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    f.recover();

    const recovered = f.adminPriorCi(f.path, true, oid);
    expect(recovered.status, recovered.output).toBe(0);
    expect(mergeRequests(f)).toHaveLength(2);
    expect(f.state()).toMatchObject({ posts: 1, pr: { state: "MERGED" } });
    expect(f.record()).toMatchObject({
      phase: "complete",
      accepted: true,
      head: f.head,
      recovery: {
        outcome: oid,
        attempt: record.attempt,
        actor: "fixture-operator",
        reason: "explicit-operator-recovery",
        providerRejection: {
          kind: "github-base-modified-405",
          capture,
          files: { [capture]: f.git(["hash-object", "--stdin"], refusal) },
        },
      },
    });
    expect(f.record().recovery).not.toHaveProperty("preDispatchRefusal");
    expect(JSON.parse(f.git(["show", `${oid}:outcome.json`]))).toEqual(record);
    expect(f.git(["merge-base", "--is-ancestor", oid, outcomeRef])).toBe("");
    expectRetainedCapture(f, outcomeRef, capture);
    expect(existsSync(f.worktree)).toBe(false);
    const complete = f.git(["rev-parse", outcomeRef]);
    const stale = f.adminPriorCi(f.path, true, oid);
    expect(stale.status, stale.output).toBe(1);
    expect(mergeRequests(f)).toHaveLength(2);
    expect(f.git(["rev-parse", outcomeRef])).toBe(complete);
  });

  it("requires a separate decision for each rejection and retains both captures after success", () => {
    const first = rejectedAttempt();
    const { f } = first;
    f.save({ ...f.state(), restMergeRefusal: refusal });
    const second = f.adminPriorCi(f.path, true, first.oid);
    expect(second.status, second.output).toBe(1);
    const secondOid = f.git(["rev-parse", outcomeRef]);
    const secondRecord = f.record();
    const secondCapture = `merge-output.${secondRecord.attempt}.log`;
    expect(secondOid).not.toBe(first.oid);
    expect(secondCapture).not.toBe(first.capture);
    expect(secondRecord).toMatchObject({ phase: "intent", accepted: false });
    expect(mergeRequests(f)).toHaveLength(2);
    expectRetainedCapture(f, secondOid, first.capture);
    expect(f.recover()).toBe(false);

    const stale = f.adminPriorCi(f.path, true, first.oid);
    expect(stale.status, stale.output).toBe(1);
    expect(mergeRequests(f)).toHaveLength(2);
    expect(f.git(["rev-parse", outcomeRef])).toBe(secondOid);
    f.recover();
    f.save({ ...f.state(), restMergeRefusal: "" });
    const final = f.adminPriorCi(f.path, true, secondOid);
    expect(final.status, final.output).toBe(0);
    expect(mergeRequests(f)).toHaveLength(3);
    expect(f.record()).toMatchObject({
      phase: "complete",
      recovery: { outcome: secondOid, providerRejection: { capture: secondCapture } },
    });
    expect(Object.keys(f.record().recovery.providerRejection.files).toSorted()).toEqual(
      [first.capture, secondCapture].toSorted(),
    );
    for (const capture of [first.capture, secondCapture]) {
      expectRetainedCapture(f, outcomeRef, capture);
    }
    for (const [oid, record] of [
      [first.oid, first.record],
      [secondOid, secondRecord],
    ] as const) {
      expect(JSON.parse(f.git(["show", `${oid}:outcome.json`]))).toEqual(record);
      expect(f.git(["merge-base", "--is-ancestor", oid, outcomeRef])).toBe("");
    }
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each([
    [
      "generic 405",
      refusal.replaceAll(
        "Base branch was modified. Review and try the merge again.",
        "Method Not Allowed",
      ),
    ],
    ["5xx", refusal.replaceAll("405", "502")],
    ["truncated", refusal.slice(0, -20)],
    ["mixed success", refusal + '{"merged":true}\n'],
  ])("does not authorize a retry from %s capture bytes", (_name, response) => {
    const { f, oid, capture } = rejectedAttempt(response);
    const result = f.adminPriorCi(f.path, true, oid);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("complete exact GitHub base-modified HTTP 405 rejection");
    expect(mergeRequests(f)).toHaveLength(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(response);
  });

  it.each(["symlink", "extra capture"])(
    "refuses %s without consuming the retained intent",
    (fault) => {
      const { f, oid, capture } = rejectedAttempt();
      const target = join(f.root, "original-capture.txt");
      writeFileSync(target, refusal);
      if (fault === "symlink") {
        const path = join(f.worktree, ".local", capture);
        rmSync(path);
        symlinkSync(target, path);
      } else {
        writeFileSync(join(f.worktree, ".local/merge-output.unknown.log"), refusal);
      }
      const result = f.adminPriorCi(f.path, true, oid);
      expect(result.status, result.output).toBe(1);
      expect(mergeRequests(f)).toHaveLength(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
      expect(readFileSync(target, "utf8")).toBe(refusal);
    },
  );

  it.each(["accepted", "ordinary route", "unconfirmed"])(
    "refuses %s recovery authority even with exact provider bytes",
    (fault) => {
      const { f, oid } = rejectedAttempt();
      const expected =
        fault === "unconfirmed"
          ? oid
          : rewriteRecord(
              f,
              fault === "accepted"
                ? { accepted: true }
                : fault === "ordinary route"
                  ? { route: "immediate", priorCiAdmin: undefined }
                  : { priorCiAdmin: undefined },
            );
      const result = f.adminPriorCi(f.path, fault !== "unconfirmed", expected);
      expect(result.status, result.output).not.toBe(0);
      expect(mergeRequests(f)).toHaveLength(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(expected);
    },
  );

  it.each(["head", "gates", "review", "admin", "security", "CI attempt", "evidence"])(
    "revalidates current %s before a recovery request",
    (fault) => {
      const { f, oid } = rejectedAttempt();
      const state = f.state();
      if (fault === "head") {
        state.pr.headRefOid = f.base;
      }
      if (fault === "gates") {
        writeFileSync(
          join(f.worktree, ".local/gates.env"),
          `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.base}\n`,
        );
      }
      if (fault === "review") {
        state.priorCi.reviewDecision = "REVIEW_REQUIRED";
      }
      if (fault === "admin") {
        state.priorCi.membership = "member";
      }
      if (fault === "security") {
        state.priorCi.security.fault = "failed-guard";
      }
      if (fault === "CI attempt") {
        state.priorCi.latestAttempt = 3;
      }
      if (fault === "evidence") {
        state.priorCi.mutateEvidence = true;
      }
      f.save(state);
      const result = f.adminPriorCi(f.path, true, oid);
      expect(result.status, result.output).toBe(1);
      expect(mergeRequests(f)).toHaveLength(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
      expect(f.state().pr.mergeCommit).toBeNull();
    },
  );

  it("rechecks rejection bytes after the final awaited metadata read", () => {
    const { f, oid } = rejectedAttempt();
    f.save({
      ...f.state(),
      observationReads: 0,
      observations: [{}, {}, {}, {}, { tamperProviderCapture: true }],
    });
    const result = f.adminPriorCi(f.path, true, oid);
    expect(result.status, result.output).toBe(1);
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(result.output).toContain("provider rejection");
    expect(mergeRequests(f)).toHaveLength(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
  });

  it("does not overwrite a competing outcome at the recovery intent CAS", () => {
    const { f, oid, capture } = rejectedAttempt();
    f.save({ ...f.state(), crash: "successor" });
    const result = f.adminPriorCi(f.path, true, oid);
    expect(result.status, result.output).toBe(1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(mergeRequests(f)).toHaveLength(1);
    expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(refusal);
    expect(JSON.parse(f.git(["show", `${oid}:outcome.json`])).accepted).toBe(false);
  });

  it("reconciles an already merged PR without submitting the rejected request again", () => {
    const { f, oid } = rejectedAttempt();
    const landed = f.commit(f.git(["merge-tree", "--write-tree", f.base, f.head]), [f.base]);
    f.git(["push", "-q", "origin", `${landed}:refs/heads/main`]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const retry = f.adminPriorCi(f.path, true, oid);
    expect(retry.status, retry.output).toBe(1);
    expect(mergeRequests(f)).toHaveLength(1);
    f.recover();
    const reconciled = f.run();
    expect(reconciled.status, reconciled.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    expect(mergeRequests(f)).toHaveLength(1);
    expect(f.state().posts).toBe(0);
  });
});
