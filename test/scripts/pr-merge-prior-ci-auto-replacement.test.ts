import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  expectExit,
  configureMerge,
  expectCapturedFiles,
  expectAncestors,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, reuseCompletedSetup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const uncertainGatewayResponse = '{\n  "message": "Server Error"\n}\ngh: Server Error (HTTP 502)\n';
const providerRejection = readFileSync(
  new URL("../fixtures/pr-admin-base-modified-405.txt", import.meta.url),
  "utf8",
);

const cancelledAutoReplacement = reuseCompletedSetup(function (
  options: { cancellation?: "confirmed" | "missing" | "uncertain"; replace?: boolean } = {},
) {
  const cancellation = options.cancellation ?? "confirmed";
  const initial = fixture();
  configureMerge(initial, {
    mode: "pending",
    pr: { mergeStateStatus: "BLOCKED" },
  });
  expectExit(initial.run(true), 0);
  const originalOid = initial.git(["rev-parse", outcomeRef]);
  const originalRecord = initial.record();
  expect(originalRecord).toMatchObject({ phase: "intent", route: "auto", accepted: true });
  const captures = initial.captures();
  expect(captures).toHaveLength(1);

  if (cancellation !== "missing") {
    configureMerge(initial, {
      cancellation: cancellation === "uncertain" ? "rejected" : "success",
    });
    expectExit(initial.cancel(originalOid), cancellation === "confirmed" ? 0 : 1);
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
    configureMerge(initial, { pr: { autoMergeRequest: null } });
  }
  expect(initial.state().pr.autoMergeRequest).toBeNull();

  const replacement = options.replace === false ? initial.head : initial.replacePreparedHead();
  expect(replacement === originalRecord.head).toBe(options.replace === false);
  const main = initial.git(["--git-dir=" + initial.remote, "rev-parse", "refs/heads/main"]);
  const f = preExistingCandidate(undefined, { ...initial, head: replacement, base: main });
  configureMerge(f, { mode: "success" });
  expect(JSON.parse(readFileSync(join(f.worktree, ".local/review.json"), "utf8"))).toMatchObject({
    tests: { result: "fail", preExistingCi: { head: replacement, runId: 501, runAttempt: 2 } },
  });
  return { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement, captures };
});

const staleAdminReplacement = reuseCompletedSetup(function (ready = false) {
  const cancelled = cancelledAutoReplacement({ replace: false });
  const { f, retiredOid } = cancelled;
  configureMerge(f, { restMergeRefusal: uncertainGatewayResponse });
  expectExit(f.adminPriorCi(f.path, true, retiredOid, f.head), 1);
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
  configureMerge(f, {
    mode: ready ? "success" : "pending",
    gates: ready ? "pass" : "pending",
    requiredCheckName: "openclaw/ci-gate",
    restContexts: ["openclaw/ci-gate", "Security Review"],
    restMergeRefusal: "",
    pr: { mergeStateStatus: ready ? "CLEAN" : "BLOCKED" },
  });
  return {
    ...cancelled,
    f: { ...f, head: replacement },
    adminOid,
    adminRecord,
    adminCapture,
    replacement,
  };
});

const rejectedCancelledAutoAdmin = reuseCompletedSetup(function () {
  const cancelled = cancelledAutoReplacement({ replace: false });
  const { f, retiredOid } = cancelled;
  configureMerge(f, { restMergeRefusal: providerRejection });
  expectExit(f.adminPriorCi(f.path, true, retiredOid, f.head), 1);
  const adminOid = f.git(["rev-parse", outcomeRef]);
  const adminRecord = f.record();
  expect(adminRecord).toMatchObject({ phase: "intent", route: "admin", accepted: false });
  expect(f.recover()).toBe(false);
  return { ...cancelled, adminOid, adminRecord };
});

const recoveredStaleAdminAuto = reuseCompletedSetup(function () {
  const setup = staleAdminReplacement();
  expectExit(setup.f.run(true, setup.f.repo, "squash", setup.adminOid, setup.replacement), 0);
  const recoveredOid = setup.f.git(["rev-parse", outcomeRef]);
  const recoveredRecord = setup.f.record();
  expect(recoveredRecord).toMatchObject({
    phase: "intent",
    route: "auto",
    accepted: true,
    recovery: { outcome: setup.adminOid },
  });
  return { ...setup, recoveredOid, recoveredRecord };
});

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
  it("lands a clean replacement immediately while retaining the retired admin history", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord, replacement } =
      staleAdminReplacement(true);
    const captures = f.captures();

    expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 1 });
    expect(f.state().pr.autoMergeRequest).toBeNull();
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "immediate",
      accepted: true,
      head: replacement,
      recovery: {
        outcome: adminOid,
        attempt: adminRecord.attempt,
        replacementHead: replacement,
        staleHeadRetirement: { kind: "github-rest-sha-head-fenced" },
      },
    });
    expect(f.record()).not.toHaveProperty("priorCiAdmin");
    expect(f.record().recovery).not.toHaveProperty("providerRejection");
    expectAncestors(f, [originalOid, retiredOid, adminOid], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each([
    ["pending required check", "passing required checks for immediate admission"],
    ["failed required check", "Required checks are failing"],
    ["final projection drift", "requires MERGEABLE/CLEAN immediate admission"],
    ["final capture mutation", "inherited stale-head capture changed"],
  ])("refuses clean replacement with %s", (fault, diagnostic) => {
    const { f, adminOid, replacement, captures } = staleAdminReplacement(true);
    const state = f.state();
    if (fault === "pending required check" || fault === "failed required check") {
      state.gates = fault === "pending required check" ? "pending" : "fail";
    } else {
      state.observationReads = 0;
      state.observations = [
        {},
        fault === "final projection drift"
          ? { advanceMain: true, pr: { mergeStateStatus: "UNSTABLE" } }
          : { tamperProviderCapture: captures[0]![0] },
      ];
    }
    f.save(state);
    const recovered = expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 1);
    expect(recovered.output).toContain(diagnostic);
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
    expect(f.state().pr.autoMergeRequest).toBeNull();
  });

  it("recovers repeated provider rejections while retaining the cancelled auto capture", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord } = rejectedCancelledAutoAdmin();
    const firstCaptures = f.captures();
    expect(firstCaptures).toHaveLength(2);
    expect(firstCaptures.some(([, bytes]) => bytes === "")).toBe(true);

    expectExit(f.adminPriorCi(f.path, true, adminOid), 1);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    const secondOid = f.git(["rev-parse", outcomeRef]);
    expect(secondOid).not.toBe(adminOid);
    expect(f.record()).toMatchObject({
      phase: "intent",
      accepted: false,
      recovery: {
        outcome: adminOid,
        providerRejection: { capture: `merge-output.${adminRecord.attempt}.log` },
      },
    });
    expect(f.recover()).toBe(false);
    const captures = f.captures();
    expect(captures).toHaveLength(3);
    configureMerge(f, { restMergeRefusal: "" });

    expectExit(f.adminPriorCi(f.path, true, secondOid), 0);
    expect(f.state()).toMatchObject({ mutations: 4, cancellations: 1, posts: 1 });
    expect(f.record()).toMatchObject({ phase: "complete", accepted: true, head: f.head });
    expect(Object.keys(f.record().recovery.providerRejection.files).toSorted()).toEqual(
      captures.map(([name]) => name).toSorted(),
    );
    expectCapturedFiles(f, captures, outcomeRef);
    expectAncestors(f, [originalOid, retiredOid, adminOid, secondOid], outcomeRef);
    expect(JSON.parse(f.git(["show", `${retiredOid}:outcome.json`]))).toMatchObject({
      accepted: true,
      cancellation: { state: "confirmed" },
    });
    expect(existsSync(f.worktree)).toBe(false);
  });

  it.each([
    ["changed inherited", "inherited provider-rejection capture changed"],
    ["missing inherited", "exactly the expected captures"],
    ["symlink inherited", "regular nonsymlink files"],
    ["extra", "exactly the expected captures"],
    ["missing current", "exactly the expected captures"],
    ["changed current", "complete exact GitHub base-modified HTTP 405 rejection"],
  ])("refuses provider recovery with %s capture", (fault, diagnostic) => {
    const { f, adminOid, adminRecord, captures } = rejectedCancelledAutoAdmin();
    const inheritedPath = join(f.worktree, ".local", captures[0]![0]);
    const currentPath = join(f.worktree, ".local", `merge-output.${adminRecord.attempt}.log`);
    if (fault === "changed inherited") {
      writeFileSync(inheritedPath, "changed\n");
    } else if (fault === "missing inherited" || fault === "symlink inherited") {
      rmSync(inheritedPath);
      if (fault === "symlink inherited") {
        const target = join(f.root, "original-auto-capture.txt");
        writeFileSync(target, captures[0]![1]);
        symlinkSync(target, inheritedPath);
      }
    } else if (fault === "extra") {
      writeFileSync(join(f.worktree, ".local/merge-output.extra.log"), "extra\n");
    } else if (fault === "missing current") {
      rmSync(currentPath);
    } else {
      writeFileSync(currentPath, uncertainGatewayResponse);
    }
    const recovered = expectExit(f.adminPriorCi(f.path, true, adminOid), 1);
    expect(recovered.output).toContain(diagnostic);
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
  });

  it("rechecks inherited provider recovery captures after final admission", () => {
    const { f, adminOid, adminRecord, captures } = rejectedCancelledAutoAdmin();
    configureMerge(f, {
      observationReads: 0,
      observations: [{}, {}, {}, {}, { tamperProviderCapture: captures[0]![0] }],
    });
    const recovered = expectExit(f.adminPriorCi(f.path, true, adminOid), 1);
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(recovered.output).toContain("inherited provider-rejection capture changed");
    expect(
      readFileSync(join(f.worktree, ".local", `merge-output.${adminRecord.attempt}.log`), "utf8"),
    ).toBe(providerRejection);
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
  });

  it("retires a recovered auto request at an observed head and preserves the complete capture chain", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord, adminCapture, replacement } =
      staleAdminReplacement();
    const captures = f.captures();
    expect(captures).toHaveLength(2);

    const recovered = expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 0);
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
    expectAncestors(f, [originalOid, retiredOid, adminOid], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);

    const observed = f.commit(f.tree("collaborator replacement\n"), [f.base]);
    configureMerge(f, { pr: { headRefOid: observed, autoMergeRequest: null } });
    expectExit(f.cancel(recoveredOid, observed), 0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.record()).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: true,
      cancellation: { state: "confirmed", outcome: recoveredOid, observedHead: observed },
      recovery: recoveredRecord.recovery,
    });
    const cancelledOid = f.git(["rev-parse", outcomeRef]);
    expectAncestors(f, [originalOid, retiredOid, adminOid, recoveredOid], cancelledOid);
    expectCapturedFiles(f, recoveryCaptures, cancelledOid);

    const nextReplacement = f.replacePreparedHead();
    configureMerge(f, {
      mode: "success",
      gates: "pass",
      pr: { mergeStateStatus: "CLEAN" },
    });
    expectExit(f.run(false, f.repo, "squash", cancelledOid, nextReplacement), 0);
    expect(f.state()).toMatchObject({ mutations: 4, cancellations: 1, posts: 1 });
    expect(f.record()).toMatchObject({
      phase: "complete",
      head: nextReplacement,
      recovery: { outcome: cancelledOid, replacementHead: nextReplacement },
    });
    const subsequentIntent = f
      .git(["rev-list", "--ancestry-path", "--reverse", `${cancelledOid}..${outcomeRef}`])
      .split("\n")[0]!;
    expectAncestors(f, [originalOid, retiredOid, adminOid, recoveredOid, cancelledOid], outcomeRef);
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
    configureMerge(f, { mode: "pending-error" });

    expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 1);
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

    configureMerge(f, { cancellation: "success" });
    expectExit(f.cancel(recoveredOid), 0);
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

  it.each([false, true])("reconciles an interrupted recovered merge (ready=%s)", (ready) => {
    const { f, adminOid, replacement } = staleAdminReplacement(ready);
    configureMerge(f, { mode: "success", crash: "dispatch" });

    const attempted = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(attempted.status, attempted.output).not.toBe(0);
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    expect(recoveredRecord).toMatchObject({
      phase: "intent",
      route: ready ? "immediate" : "auto",
      accepted: false,
      recovery: { outcome: adminOid },
    });
    const attemptCapture = `merge-output.${recoveredRecord.attempt}.log`;
    const attemptBytes = readFileSync(join(f.worktree, ".local", attemptCapture), "utf8");
    expect(() => f.git(["cat-file", "-e", `${recoveredOid}:${attemptCapture}`])).toThrow();
    expect(f.recover()).toBe(true);
    configureMerge(f, { crash: "" });
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "refs/heads/main"]);

    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({
      phase: "merged",
      route: ready ? "immediate" : "auto",
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

  it.each([
    "a changed successor capture",
    "an extra capture",
    "a missing capture",
    "a symlink capture",
  ])("refuses cancellation with %s", (fault) => {
    const { f, recoveredOid, recoveredRecord } = recoveredStaleAdminAuto();
    if (fault === "a changed successor capture") {
      writeFileSync(
        join(f.worktree, ".local", `merge-output.${recoveredRecord.attempt}.log`),
        "changed successor capture\n",
      );
    } else if (fault === "a missing capture" || fault === "a symlink capture") {
      const capture = join(f.worktree, ".local", `merge-output.${recoveredRecord.attempt}.log`);
      rmSync(capture);
      if (fault === "a symlink capture") {
        symlinkSync(join(f.root, "absent-capture"), capture);
      }
    } else {
      writeFileSync(join(f.worktree, ".local/merge-output.extra.log"), "extra\n");
    }
    const observed = f.commit(f.tree("collaborator replacement\n"), [f.base]);
    configureMerge(f, { pr: { headRefOid: observed, autoMergeRequest: null } });

    const cancelled = expectExit(f.cancel(recoveredOid, observed), 1);
    expect(cancelled.output).toContain(
      fault === "a changed successor capture"
        ? "merge capture changed before retention"
        : fault === "a symlink capture"
          ? "cannot retain non-regular capture"
          : "merge capture set changed before retention",
    );
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(recoveredOid);
  });

  it.each(["a changed successor capture", "an extra capture"])(
    "refuses subsequent recovery with %s",
    (fault) => {
      const { f, recoveredOid, recoveredRecord } = recoveredStaleAdminAuto();
      configureMerge(f, { cancellation: "success" });
      expectExit(f.cancel(recoveredOid), 0);
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
      configureMerge(f, {
        mode: "success",
        gates: "pass",
        pr: { mergeStateStatus: "CLEAN" },
      });

      const resumed = expectExit(f.run(false, f.repo, "squash", cancelledOid, nextReplacement), 1);
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
      expectExit(f.run(true, f.repo, "squash", outcome, selectedHead), 1);
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
      expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 1);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    },
  );

  it("refuses stale-head capture bytes changed during final admission", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    configureMerge(f, {
      observationReads: 0,
      observations: [{ tamperProviderCapture: true }],
    });
    const result = expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 1);
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
    } else {
      const reviewPath = join(f.worktree, ".local/review.json");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      review.recommendation = "NEEDS WORK";
      writeFileSync(reviewPath, JSON.stringify(review));
    }
    f.save(state);
    expectExit(f.run(true, f.repo, "squash", adminOid, replacement), 1);
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
        configureMerge(f, { observations: [{}, {}, {}, {}, { advanceMain: true }] });
      }
      const recovered = expectExit(f.adminPriorCi(f.path, true, retiredOid, replacement), 0);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
      if (!replace) {
        expect(f.state().mainAdvances).toHaveLength(1);
        expect(recovered.output).toContain("Admin authority round 2:");
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
      expectCapturedFiles(f, captures, successorIntent);
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
    applyFault(fault, {
      "renewed auto request": () => (state.pr.autoMergeRequest = { mergeMethod: "SQUASH" }),
      "revoked admin": () => (state.priorCi.membership = "member"),
    });
    if (fault === "revoked admin after materialization") {
      state.priorCi.revokeAdminOnMainFetch = true;
      state.observations = [{}, {}, {}, {}, { advanceMain: true }];
    }
    applyFault(fault, {
      "required review": () => (state.priorCi.reviewDecision = "REVIEW_REQUIRED"),
      "failed security": () => (state.priorCi.security.fault = "failed-guard"),
      "new CI attempt": () => (state.priorCi.latestAttempt = 3),
      "original CI head": () => (state.priorCi.runHead = originalRecord.head),
    });
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
    const result = expectExit(f.adminPriorCi(f.path), 1);
    expect(result.output).toContain("PR identity/head/base drift from the retained attempt");
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it.each([true])("refuses captures changed during final admission (replace=%s)", (replace) => {
    const { f, retiredOid, replacement } = cancelledAutoReplacement({ replace });
    configureMerge(f, {
      observationReads: 0,
      observations: [{}, {}, {}, {}, { tamperProviderCapture: true }],
    });
    const result = expectExit(f.adminPriorCi(f.path, true, retiredOid, replacement), 1);
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(result.output).toContain("recovery artifacts changed during admission");
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it.each([true])(
    "preserves the recovery CAS successor without dispatch (replace=%s)",
    (replace) => {
      const { f, retiredOid, replacement } = cancelledAutoReplacement({ replace });
      configureMerge(f, { crash: "successor" });
      const result = expectExit(f.adminPriorCi(f.path, true, retiredOid, replacement), 1);
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
