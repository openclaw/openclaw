import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  expectRecovery,
  applyFault,
  expectExit,
  configureMerge,
  expectCapturedFiles,
  expectAncestors,
  readLocal,
  pendingGates,
  writeLocal,
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
type Fixture = ReturnType<typeof fixture>;

function expectAdminIntentRetained(
  f: ReturnType<typeof preExistingCandidate>,
  oid: string,
  diagnostic: string,
) {
  const result = expectExit(f.adminPriorCi(f.path, true, oid), 1);
  expect(result.output).toContain(diagnostic);
  expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
  expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
  return result;
}

const autoIntent = { phase: "intent", route: "auto", accepted: true };

function damageCapture(f: Fixture, name: string, fault: string, bytes?: string) {
  const path = join(f.worktree, ".local", name);
  if (fault === "changed") {
    writeFileSync(path, bytes ?? "changed successor capture\n");
  } else if (fault === "extra") {
    writeLocal(f, "merge-output.extra.log", "extra\n");
  } else {
    rmSync(path);
    if (fault === "symlink") {
      const target = join(f.root, "capture-target");
      if (bytes !== undefined) {
        writeFileSync(target, bytes);
      }
      symlinkSync(target, path);
    }
  }
}

function uncommittedCapture(f: Fixture, oid: string, attempt: string) {
  const name = `merge-output.${attempt}.log`;
  const bytes = readLocal(f, name);
  expect(() => f.git(["cat-file", "-e", `${oid}:${name}`])).toThrow();
  return [[name, bytes]] as const;
}

function observeReplacement(f: Fixture) {
  const observed = f.commit(f.tree("collaborator replacement\n"), [f.base]);
  configureMerge(f, { pr: { headRefOid: observed, autoMergeRequest: null } });
  return observed;
}

const cancelledAutoReplacement = reuseCompletedSetup(function (
  options: { cancellation?: "confirmed" | "missing" | "uncertain"; replace?: boolean } = {},
) {
  const cancellation = options.cancellation ?? "confirmed";
  const initial = fixture();
  configureMerge(initial, { mode: "pending", pr: { mergeStateStatus: "BLOCKED" } });
  expectExit(initial.run(true), 0);
  const originalOid = initial.git(["rev-parse", outcomeRef]);
  const originalRecord = initial.record();
  const captures = initial.captures();

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
  // Absence on the provider alone must not substitute for confirmed retirement evidence.
  if (cancellation !== "confirmed") {
    configureMerge(initial, { pr: { autoMergeRequest: null } });
  }
  const replacement = options.replace === false ? initial.head : initial.replacePreparedHead();
  const main = initial.git(["--git-dir=" + initial.remote, "rev-parse", "refs/heads/main"]);
  const f = preExistingCandidate(undefined, { ...initial, head: replacement, base: main });
  configureMerge(f, { mode: "success" });
  return { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement, captures };
});

function rejectedAdmin(response: string) {
  const cancelled = cancelledAutoReplacement({ replace: false });
  const { f, retiredOid } = cancelled;
  configureMerge(f, { restMergeRefusal: response });
  expectExit(f.adminPriorCi(f.path, true, retiredOid, f.head), 1);
  const adminOid = f.git(["rev-parse", outcomeRef]);
  const adminRecord = f.record();
  expect(adminRecord).toMatchObject({ phase: "intent", route: "admin", accepted: false });
  expect(f.recover()).toBe(false);
  return { ...cancelled, adminOid, adminRecord };
}

const staleAdminReplacement = reuseCompletedSetup(function (ready = false) {
  const cancelled = rejectedAdmin(uncertainGatewayResponse);
  const { f, retiredOid, adminRecord } = cancelled;
  expect(adminRecord).toMatchObject({
    head: f.head,
    recovery: { outcome: retiredOid, replacementHead: f.head },
  });
  const adminCapture = `merge-output.${adminRecord.attempt}.log`;
  expect(readLocal(f, adminCapture)).toBe(uncertainGatewayResponse);

  const replacement = f.replacePreparedHead();
  pendingGates(f, replacement);
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
    adminCapture,
    replacement,
  };
});

const rejectedCancelledAutoAdmin = reuseCompletedSetup(() => rejectedAdmin(providerRejection));

const recoveredStaleAdminAuto = reuseCompletedSetup(function () {
  const setup = staleAdminReplacement();
  expectExit(setup.f.run(true, setup.f.repo, "squash", setup.adminOid, setup.replacement), 0);
  const recoveredOid = setup.f.git(["rev-parse", outcomeRef]);
  const recoveredRecord = setup.f.record();
  expect(recoveredRecord).toMatchObject({
    ...autoIntent,
    recovery: { outcome: setup.adminOid },
  });
  return { ...setup, recoveredOid, recoveredRecord };
});

function rewriteRecord(f: Fixture, changes: Record<string, unknown>) {
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
  it("lands a clean replacement with retired-admin history", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord, replacement } =
      staleAdminReplacement(true);
    const captures = f.captures();

    expectRecovery(f, adminOid, replacement, 0, true);
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
    const recovered = expectRecovery(f, adminOid, replacement, 1, true);
    expect(recovered.output).toContain(diagnostic);
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 0 });
    expect(f.state().pr.autoMergeRequest).toBeNull();
  });

  it("retains cancelled-auto capture across repeated provider rejections", () => {
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
    const inherited = fault.endsWith("inherited");
    damageCapture(
      f,
      inherited ? captures[0]![0] : `merge-output.${adminRecord.attempt}.log`,
      fault.split(" ")[0]!,
      fault === "symlink inherited"
        ? captures[0]![1]
        : inherited
          ? "changed\n"
          : uncertainGatewayResponse,
    );
    expectAdminIntentRetained(f, adminOid, diagnostic);
  });

  it("rechecks inherited provider recovery captures after final admission", () => {
    const { f, adminOid, adminRecord, captures } = rejectedCancelledAutoAdmin();
    configureMerge(f, {
      observationReads: 0,
      observations: [{}, {}, {}, {}, { tamperProviderCapture: captures[0]![0] }],
    });
    expectAdminIntentRetained(f, adminOid, "inherited provider-rejection capture changed");
    expect(f.state().providerCaptureTampered).toBe(true);
    expect(readLocal(f, `merge-output.${adminRecord.attempt}.log`)).toBe(providerRejection);
  });

  it("retains the capture chain through recovered-auto retirement", () => {
    const { f, originalOid, retiredOid, adminOid, adminRecord, adminCapture, replacement } =
      staleAdminReplacement();
    const captures = f.captures();
    expect(captures).toHaveLength(2);

    const recovered = expectRecovery(f, adminOid, replacement, 0, true);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.state().pr.autoMergeRequest).toEqual({ mergeMethod: "SQUASH" });
    expect(f.record(), recovered.output).toMatchObject({
      ...autoIntent,
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

    const observed = observeReplacement(f);
    expectExit(f.cancel(recoveredOid, observed), 0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expect(f.record()).toMatchObject({
      ...autoIntent,
      cancellation: { state: "confirmed", outcome: recoveredOid, observedHead: observed },
      recovery: recoveredRecord.recovery,
    });
    const cancelledOid = f.git(["rev-parse", outcomeRef]);
    expectAncestors(f, [originalOid, retiredOid, adminOid, recoveredOid], cancelledOid);
    expectCapturedFiles(f, recoveryCaptures, cancelledOid);

    const nextReplacement = f.replacePreparedHead();
    configureMerge(f, { mode: "success", gates: "pass", pr: { mergeStateStatus: "CLEAN" } });
    expectRecovery(f, cancelledOid, nextReplacement);
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
    expectCapturedFiles(f, recoveryCaptures, subsequentIntent);
    expectCapturedFiles(f, recoveryCaptures, outcomeRef);
    expect(existsSync(f.worktree)).toBe(false);
  });

  it("retains an uncertain recovered-auto capture on cancellation", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    configureMerge(f, { mode: "pending-error" });

    expectRecovery(f, adminOid, replacement, 1, true);
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    expect(recoveredRecord).toMatchObject({
      ...autoIntent,
      accepted: false,
      recovery: { outcome: adminOid },
    });
    const capture = uncommittedCapture(f, recoveredOid, recoveredRecord.attempt);
    expect(f.recover()).toBe(false);

    configureMerge(f, { cancellation: "success" });
    expectExit(f.cancel(recoveredOid), 0);
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 2, posts: 0 });
    expect(f.record()).toMatchObject({
      ...autoIntent,
      accepted: false,
      cancellation: { state: "confirmed", outcome: recoveredOid },
    });
    expectAncestors(f, [recoveredOid], outcomeRef);
    expectCapturedFiles(f, capture, outcomeRef);
  });

  it.each([false, true])("reconciles an interrupted recovered merge (ready=%s)", (ready) => {
    const { f, adminOid, replacement } = staleAdminReplacement(ready);
    configureMerge(f, { mode: "success", crash: "dispatch" });

    const attempted = f.run(true, f.repo, "squash", adminOid, replacement);
    expect(attempted.status, attempted.output).not.toBe(0);
    const recoveredOid = f.git(["rev-parse", outcomeRef]);
    const recoveredRecord = f.record();
    const recovery = {
      route: ready ? "immediate" : "auto",
      accepted: false,
      recovery: { outcome: adminOid },
    };
    expect(recoveredRecord).toMatchObject({ phase: "intent", ...recovery });
    const capture = uncommittedCapture(f, recoveredOid, recoveredRecord.attempt);
    expect(f.recover()).toBe(true);
    configureMerge(f, { crash: "" });
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "refs/heads/main"]);

    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "merged", ...recovery, landed });
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: 1, posts: 0 });
    expectAncestors(f, [recoveredOid], outcomeRef);
    expectCapturedFiles(f, capture, outcomeRef);
  });

  it.each([
    ["cancellation", "changed"],
    ["cancellation", "extra"],
    ["cancellation", "missing"],
    ["cancellation", "symlink"],
    ["subsequent recovery", "changed"],
    ["subsequent recovery", "extra"],
  ])("refuses %s with %s capture", (stage, fault) => {
    const { f, recoveredOid, recoveredRecord } = recoveredStaleAdminAuto();
    let retained = recoveredOid;
    let replacement = "";
    const recovery = stage === "subsequent recovery";
    if (recovery) {
      configureMerge(f, { cancellation: "success" });
      expectExit(f.cancel(recoveredOid), 0);
      retained = f.git(["rev-parse", outcomeRef]);
      replacement = f.replacePreparedHead();
      configureMerge(f, { mode: "success", gates: "pass", pr: { mergeStateStatus: "CLEAN" } });
    }
    damageCapture(f, `merge-output.${recoveredRecord.attempt}.log`, fault);
    const result = recovery
      ? expectRecovery(f, retained, replacement, 1)
      : expectExit(f.cancel(recoveredOid, observeReplacement(f)), 1);
    expect(result.output).toContain(
      fault === "changed"
        ? "merge capture changed before retention"
        : fault === "symlink"
          ? "cannot retain non-regular capture"
          : "merge capture set changed before retention",
    );
    expect(f.state()).toMatchObject({ mutations: 3, cancellations: recovery ? 2 : 1, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retained);
  });

  type Selection = { outcome?: string; head?: string; retained?: string };
  const staleFaults: Record<
    string,
    (s: ReturnType<typeof staleAdminReplacement>) => Selection | void
  > = {
    "same head": (s) => ({ head: s.adminRecord.head }),
    "accepted admin": (s) => ({ outcome: rewriteRecord(s.f, { accepted: true }) }),
    "stale outcome": (s) => ({ outcome: s.retiredOid, retained: s.adminOid }),
    "route mismatch": (s) => ({
      outcome: rewriteRecord(s.f, { route: "immediate", priorCiAdmin: undefined }),
    }),
    "method mismatch": (s) => ({ outcome: rewriteRecord(s.f, { method: "merge" }) }),
    "missing capture": (s) => damageCapture(s.f, s.adminCapture, "missing"),
    "symlink capture": (s) =>
      damageCapture(s.f, s.adminCapture, "symlink", uncertainGatewayResponse),
    "extra capture": (s) => writeLocal(s.f, "merge-output.extra.log", "extra\n"),
    closed: (s) => configureMerge(s.f, { pr: { state: "CLOSED" } }),
    merged: (s) => configureMerge(s.f, { pr: { state: "MERGED", mergeCommit: { oid: s.f.base } } }),
    "current-head drift": (s) => configureMerge(s.f, { pr: { headRefOid: s.f.base } }),
    "stale gate binding": (s) => pendingGates(s.f, s.f.base),
    "failed required check": (s) => configureMerge(s.f, { gates: "fail" }),
    "invalid current review": (s) => {
      const review = JSON.parse(readLocal(s.f, "review.json"));
      writeLocal(s.f, "review.json", JSON.stringify({ ...review, recommendation: "NEEDS WORK" }));
    },
  };
  it.each(Object.entries(staleFaults))(
    "refuses stale-head auto recovery with %s",
    (_fault, mutate) => {
      const setup = staleAdminReplacement();
      const { f, adminOid, replacement } = setup;
      const selection = mutate(setup) ?? {};
      const outcome = selection.outcome ?? adminOid;
      expectRecovery(f, outcome, selection.head ?? replacement, 1, true);
      expect(f.state()).toMatchObject({
        mutations: 2,
        cancellations: 1,
        posts: 0,
        pr: { autoMergeRequest: null },
      });
      expect(f.git(["rev-parse", outcomeRef])).toBe(selection.retained ?? outcome);
    },
  );

  it("refuses stale-head capture bytes changed during final admission", () => {
    const { f, adminOid, replacement } = staleAdminReplacement();
    configureMerge(f, { observationReads: 0, observations: [{ tamperProviderCapture: true }] });
    const result = expectRecovery(f, adminOid, replacement, 1, true);
    expect(f.state()).toMatchObject({
      providerCaptureTampered: true,
      pr: { autoMergeRequest: null },
    });
    expect(result.output).toContain("stale-head retirement evidence changed during admission");
    expect(f.git(["rev-parse", outcomeRef])).toBe(adminOid);
  });

  it.each([
    ["retained head", false],
    ["replacement head", true],
  ] as const)("lands %s with confirmed cancellation history", (_label, replace) => {
    const { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement, captures } =
      cancelledAutoReplacement({ replace });
    expect(originalRecord).toMatchObject(autoIntent);
    expect(retiredRecord).toMatchObject({
      ...autoIntent,
      cancellation: { state: "confirmed", outcome: originalOid },
    });
    expect(captures).toHaveLength(1);
    if (!replace) {
      configureMerge(f, { observations: [{}, {}, {}, {}, { advanceMain: true }] });
    }
    const recovered = expectExit(f.adminPriorCi(f.path, true, retiredOid, replacement), 0);
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
    if (!replace) {
      expect(f.state().mainAdvances).toHaveLength(1);
      expect(recovered.output).toContain("Admin authority round 2:");
    }
    expect(f.state().restMergePayload).toMatchObject({ sha: replacement, merge_method: "squash" });
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
  });

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
    ["queue enrollment", "no existing auto/queue request"],
    ["missing attribution", "every failed job must have exactly one"],
  ] as const)("refuses %s without another merge request", (fault, diagnostic) => {
    const { f, originalOid, originalRecord, retiredOid, retiredRecord, replacement } =
      cancelledAutoReplacement({
        cancellation:
          fault === "missing cancellation"
            ? "missing"
            : fault === "uncertain cancellation"
              ? "uncertain"
              : "confirmed",
        replace: !["missing replacement", "queue enrollment", "missing attribution"].includes(
          fault,
        ),
      });
    expect(retiredRecord).toMatchObject(autoIntent);
    if (fault === "missing cancellation") {
      expect(retiredRecord).not.toHaveProperty("cancellation");
    } else if (fault === "uncertain cancellation") {
      expect(retiredRecord.cancellation).toMatchObject({
        state: "requested",
        outcome: originalOid,
      });
    }
    const state = f.state();
    if (fault === "stale pending stamp") {
      pendingGates(f, originalRecord.head);
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
      "queue enrollment": () => {
        state.pr.isInMergeQueue = true;
        state.pr.isMergeQueueEnabled = true;
      },
      "missing attribution": () =>
        writeFileSync(f.path, JSON.stringify({ ...f.evidence, failures: [] })),
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

  it("does not infer recovery authority from admin evidence", () => {
    const { f, retiredOid } = cancelledAutoReplacement();
    const result = expectExit(f.adminPriorCi(f.path), 1);
    expect(result.output).toContain("PR identity/head/base drift from the retained attempt");
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
    expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
  });

  it.each([
    ["capture", "recovery artifacts changed during admission"],
    ["successor", "outcome owner changed"],
  ])("preserves recovery evidence after a %s race", (race, diagnostic) => {
    const { f, retiredOid, replacement } = cancelledAutoReplacement({ replace: true });
    configureMerge(
      f,
      race === "successor"
        ? { crash: "successor" }
        : {
            observationReads: 0,
            observations: [{}, {}, {}, {}, { tamperProviderCapture: true }],
          },
    );
    const result = expectExit(f.adminPriorCi(f.path, true, retiredOid, replacement), 1);
    expect(result.output).toContain(diagnostic);
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 1, restMergePayload: null });
    if (race === "successor") {
      expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
      expect(JSON.parse(f.git(["show", `${retiredOid}:outcome.json`]))).toMatchObject({
        accepted: true,
        cancellation: { state: "confirmed" },
      });
    } else {
      expect(f.state().providerCaptureTampered).toBe(true);
      expect(f.git(["rev-parse", outcomeRef])).toBe(retiredOid);
    }
  });
});
