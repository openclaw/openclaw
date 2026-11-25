import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  applyFault,
  configureMerge,
  expectExit,
  pendingGates,
  readLocal,
  writeLocal,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, reuseCompletedSetup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();
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

function expectAttempt(f: RecoveryFixture, oid: string, requests = 1) {
  expect(mergeRequests(f)).toHaveLength(requests);
  expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
}

const rejectedAttempt = reuseCompletedSetup(function (response: string = refusal) {
  const f = preExistingCandidate();
  configureMerge(f, { restMergeRefusal: response });
  expectExit(f.adminPriorCi(f.path), 1);
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
  expect(readLocal(f, capture)).toBe(response);
  expect(f.recover()).toBe(false);
  configureMerge(f, { restMergeRefusal: "" });
  return { f, oid, record, capture };
});

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
  it("recovers exact rejection and retains its evidence", () => {
    const { f, oid, record, capture } = rejectedAttempt();
    expectExit(f.run(), 1);
    expectAttempt(f, oid);
    f.recover();

    expectExit(f.adminPriorCi(f.path, true, oid));
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
    expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expectAttempt(f, complete, 2);
  });

  it("requires consent per rejection and retains captures", () => {
    const first = rejectedAttempt();
    const { f } = first;
    configureMerge(f, { restMergeRefusal: refusal });
    expectExit(f.adminPriorCi(f.path, true, first.oid), 1);
    const secondOid = f.git(["rev-parse", outcomeRef]);
    const secondRecord = f.record();
    const secondCapture = `merge-output.${secondRecord.attempt}.log`;
    expect(secondOid).not.toBe(first.oid);
    expect(secondCapture).not.toBe(first.capture);
    expect(secondRecord).toMatchObject({ phase: "intent", accepted: false });
    expect(mergeRequests(f)).toHaveLength(2);
    expectRetainedCapture(f, secondOid, first.capture);
    expect(f.recover()).toBe(false);

    expectExit(f.adminPriorCi(f.path, true, first.oid), 1);
    expectAttempt(f, secondOid, 2);
    f.recover();
    configureMerge(f, { restMergeRefusal: "" });
    expectExit(f.adminPriorCi(f.path, true, secondOid));
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
  ])("refuses retry from %s bytes", (_name, response) => {
    const { f, oid, capture } = rejectedAttempt(response);
    const result = expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expect(result.output).toContain("complete exact GitHub base-modified HTTP 405 rejection");
    expectAttempt(f, oid);
    expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(response);
  });

  it.each(["symlink", "extra capture"])("preserves intent on %s refusal", (fault) => {
    const { f, oid, capture } = rejectedAttempt();
    const target = join(f.root, "original-capture.txt");
    writeFileSync(target, refusal);
    if (fault === "symlink") {
      const path = join(f.worktree, ".local", capture);
      rmSync(path);
      symlinkSync(target, path);
    } else {
      writeLocal(f, "merge-output.unknown.log", refusal);
    }
    expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expectAttempt(f, oid);
    expect(readFileSync(target, "utf8")).toBe(refusal);
  });

  it.each(["accepted", "ordinary route", "unconfirmed"])(
    "refuses %s despite exact rejection bytes",
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
      expectAttempt(f, expected);
    },
  );

  it.each(["head", "gates", "review", "admin", "security", "CI attempt", "evidence"])(
    "revalidates %s before recovery",
    (fault) => {
      const { f, oid } = rejectedAttempt();
      const state = f.state();
      applyFault(fault, {
        head: () => Object.assign(state.pr, { headRefOid: f.base }),
        gates: () => pendingGates(f, f.base),
        review: () => Object.assign(state.priorCi, { reviewDecision: "REVIEW_REQUIRED" }),
        admin: () => Object.assign(state.priorCi, { membership: "member" }),
        security: () => Object.assign(state.priorCi.security, { fault: "failed-guard" }),
        "CI attempt": () => Object.assign(state.priorCi, { latestAttempt: 3 }),
        evidence: () => Object.assign(state.priorCi, { mutateEvidence: true }),
      });
      f.save(state);
      expectExit(f.adminPriorCi(f.path, true, oid), 1);
      expectAttempt(f, oid);
      expect(f.state().pr.mergeCommit).toBeNull();
    },
  );

  it("rechecks bytes after final metadata read", () => {
    const { f, oid } = rejectedAttempt();
    configureMerge(f, {
      observationReads: 0,
      observations: [{}, {}, {}, {}, { tamperProviderCapture: true }],
    });
    const result = expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(result.output).toContain("provider rejection");
    expectAttempt(f, oid);
  });

  it("preserves successor at recovery CAS", () => {
    const { f, oid, capture } = rejectedAttempt();
    configureMerge(f, { crash: "successor" });
    expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(mergeRequests(f)).toHaveLength(1);
    expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(refusal);
    expect(JSON.parse(f.git(["show", `${oid}:outcome.json`])).accepted).toBe(false);
  });

  it("reconciles merged PR without redispatch", () => {
    const { f, oid } = rejectedAttempt();
    const landed = f.commit(f.git(["merge-tree", "--write-tree", f.base, f.head]), [f.base]);
    f.git(["push", "-q", "origin", `${landed}:refs/heads/main`]);
    configureMerge(f, { pr: { state: "MERGED", mergeCommit: { oid: landed } } });
    expectExit(f.adminPriorCi(f.path, true, oid), 1);
    expect(mergeRequests(f)).toHaveLength(1);
    f.recover();
    expectExit(f.run());
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    expect(mergeRequests(f)).toHaveLength(1);
    expect(f.state().posts).toBe(0);
  });
});
