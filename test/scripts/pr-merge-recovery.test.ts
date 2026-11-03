import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  expectRecovery,
  expectRetained,
  retainIntent,
  configuredFixture,
  expectExit,
  applyFault,
  configureMerge,
  expectCapturedFiles,
  pendingGates,
  expectGraphqlSquash,
  readLocal,
  writeLocal,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
type Fixture = ReturnType<typeof fixture>;

function expectPrevious(f: Fixture, previous: string, record: ReturnType<Fixture["record"]>) {
  expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(record);
  f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
}

function expectNoDispatch(f: Fixture, output: string, mutations = 1) {
  expect(f.state(), output).toMatchObject({ mutations, posts: 0 });
}

function replaceLocal(f: Fixture, file: string, from: string, to: string) {
  writeLocal(f, file, readLocal(f, file).replaceAll(from, to));
}

const replacementFaults: Record<string, (f: Fixture, head: string) => void> = {
  "missing-approval": () => {},
  "wrong-approval": () => {},
  "malformed-approval": () => {},
  ...Object.fromEntries(
    Object.entries({
      "review-json": "review.json",
      "meta-head": "pr-meta.env",
      "prep-context": "prep-context.env",
      "prep-head": "prep.env",
      "gate-head": "gates.env",
    }).map(([fault, file]) => [
      fault,
      (f: Fixture, head: string) => replaceLocal(f, file, head, f.head),
    ]),
  ),
  "missing-context": (f) => rmSync(join(f.worktree, ".local/prep-context.env")),
  "pending-gate": (f) =>
    replaceLocal(f, "gates.env", "GATES_MODE=full", "GATES_MODE=remote_crabbox_aws_pending"),
  "ci-proof": (f) => configureMerge(f, { ciExit: 15 }),
  "head-during-checks": (f) => configureMerge(f, { duringChecks: { head: f.head } }),
  ...Object.fromEntries(
    ["prep.env", "gates.env", "review.json"].map((artifact) => [
      artifact,
      (f: Fixture) => configureMerge(f, { duringChecks: { artifact } }),
    ]),
  ),
};

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([
    { fault: "pass", gates: "pass", message: "" },
    { fault: "pending", gates: "pending", message: "Required checks are still pending" },
    { fault: "fail", gates: "fail", message: "Required checks are failing" },
    ...["stale-gate-head", "review-during-checks", "prepared-head-during-checks", "behind"].map(
      (fault) => ({ fault, gates: "pass", message: "" }),
    ),
  ])("checks current evidence for same-head recovery: $fault", ({ fault, gates, message }) => {
    const f = configuredFixture(fixture, {
      mode: "unapplied",
      requiredCheckName: "openclaw/ci-gate",
    });
    pendingGates(f);
    const { previous, previousRecord, captures } = retainIntent(f, 1, true);
    expect(previousRecord).toMatchObject({
      phase: "intent",
      route: "immediate",
      accepted: false,
      head: f.head,
    });
    f.recover();
    const next = { ...f.state(), mode: "success", gates };
    applyFault(fault, {
      "stale-gate-head": () => pendingGates(f, f.base),
      "review-during-checks": () => (next.duringChecks = { artifact: "review.json" }),
      "prepared-head-during-checks": () => (next.duringChecks = { preparedHead: f.base }),
      behind: () => (next.pr.mergeStateStatus = "BEHIND"),
    });
    f.save(next);
    const passed = fault === "pass";
    const recovered = expectRecovery(f, previous, "", passed ? 0 : 1);
    expect(f.state().mutations).toBe(passed ? 2 : 1);
    expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(previousRecord);
    if (passed) {
      expect(f.record()).toMatchObject({
        phase: "complete",
        route: "immediate",
        head: f.head,
        recovery: { outcome: previous, attempt: previousRecord.attempt },
      });
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      expectCapturedFiles(f, captures, outcomeRef);
      expect(f.state().graphqlMergePayloads[1]?.expectedHeadOid).toBe(f.head);
    } else {
      if (message) {
        expect(recovered.output).toContain(message);
      }
      if (!["pending", "fail"].includes(fault)) {
        expect(f.state().posts).toBe(0);
      }
      expectRetained(f, previous, captures);
    }
  });

  it("recovers REST projection refusal with pinned GraphQL squash", () => {
    const f = configuredFixture(fixture, {
      restPolicy: "supported",
      restDispatchChange: "projection",
    });
    const { previous, previousRecord } = retainIntent(f, 1);
    expect(previousRecord).toMatchObject({
      phase: "intent",
      accepted: false,
      transport: "rest",
      head: f.head,
    });
    expect(f.state().mutations).toBe(0);
    const captures = f.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0]![1]).toContain(
      "immediate squash requires the prepared open, non-draft, clean PR head",
    );
    f.recover();
    expectRecovery(f, previous);
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "immediate",
      head: f.head,
      recovery: { outcome: previous, attempt: previousRecord.attempt },
    });
    expect(f.state()).toMatchObject({ mutations: 1, restMergePayload: null });
    expectGraphqlSquash(f, f.state().mergeBody);
    expectPrevious(f, previous, previousRecord);
  });

  it("requires a merge body only for explicit recovery", () => {
    const f = configuredFixture(fixture, { mode: "unapplied" });
    const body = join(f.repo, "body.md");
    writeFileSync(body, "First message");
    const first = f.run(false, f.repo, "squash", "", "", body);
    expect(first.status, first.output).not.toBe(0);
    const previous = f.git(["rev-parse", outcomeRef]);
    rmSync(body);
    f.recover();
    const resumed = f.run(false, f.repo, "squash", "", "", body);
    expect(resumed.status, resumed.output).not.toBe(0);
    expect(resumed.output).not.toContain("Cannot prepare merge body");
    expect(f.state().mutations).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    f.recover();
    writeFileSync(body, "Corrected retry message");
    configureMerge(f, { mode: "success" });
    expectExit(f.run(false, f.repo, "squash", previous, "", body), 0);
    expect(f.state()).toMatchObject({ mergeBody: "Corrected retry message", mutations: 2 });
  });

  it.each([
    { replacement: true, forwardMain: false },
    { replacement: false, forwardMain: true },
    { replacement: true, forwardMain: true },
  ])(
    "retains recovery evidence (replacement=$replacement, main=$forwardMain)",
    ({ replacement, forwardMain }) => {
      const f = configuredFixture(fixture, { mode: "unapplied" });
      const { previous, previousRecord } = retainIntent(f, 1);
      if (replacement) {
        writeFileSync(join(f.repo, ".git/info/attributes"), "*.log text eol=lf\n");
        const capture = f.captures()[0]![0];
        writeLocal(f, capture, readLocal(f, capture) + "Capture byte sentinel\r\n");
      }
      const captures = f.captures();
      expect(captures).toHaveLength(1);
      f.recover();
      const approvedHead = replacement ? f.replacePreparedHead() : f.head;
      if (replacement) {
        expect(() => f.git(["merge-tree", "--write-tree", `${approvedHead}^`, f.head])).toThrow();
      }
      const next = f.state();
      next.mode = "success";
      next.comment = replacement ? "success" : "rejected";
      if (forwardMain) {
        const parent = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
        const tree = f.git(["rev-parse", `${parent}^{tree}`]);
        const main = f.commit(tree, [parent], "Admission advance\n");
        next.observations = [{}, { main }, {}, { advanceMain: true, advanceAfterRead: true }];
      }
      f.save(next);
      const recovered = expectRecovery(
        f,
        previous,
        replacement ? approvedHead : "",
        replacement ? 0 : 1,
      );
      expect(f.state().mutations, recovered.output).toBe(2);
      expect(f.state().mainAdvances).toHaveLength(forwardMain ? 2 : 0);
      expect(f.record()).toMatchObject({
        phase: replacement ? "complete" : "commenting",
        head: approvedHead,
        recovery: {
          outcome: previous,
          attempt: previousRecord.attempt,
          actor: "fixture-operator",
          reason: "explicit-operator-recovery",
          ...(replacement ? { replacementHead: approvedHead } : {}),
        },
      });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe(
        replacement ? "reviewed replacement" : "after",
      );
      expectPrevious(f, previous, previousRecord);
      const successor = f
        .git(["rev-list", "--ancestry-path", "--reverse", `${previous}..${outcomeRef}`])
        .split("\n")[0]!;
      if (replacement) {
        expectCapturedFiles(f, captures, successor);
      } else {
        for (const [name, contents] of captures) {
          expect(readLocal(f, name)).toBe(contents);
        }
        expect(f.captures()).toHaveLength(2);
      }
      const dispatches = f.state().graphqlMergePayloads;
      expect(dispatches).toHaveLength(2);
      expect(dispatches[1]!.expectedHeadOid).toBe(approvedHead);
      f.recover();
      expectExit(f.run(), 0);
      expectRecovery(f, previous, replacement ? approvedHead : "", 1);
      expect(f.state()).toMatchObject({ mutations: 2, posts: 1 });
      if (!replacement) {
        f.git(["worktree", "remove", "--force", f.worktree]);
      }
      for (const ref of "heads/topic heads/pr-123 heads/pr-123-prep remotes/origin/topic".split(
        " ",
      )) {
        f.git(["update-ref", "-d", `refs/${ref}`]);
      }
      f.git(["reflog", "expire", "--expire=now", "--all"]);
      f.git(["gc", "--prune=now"]);
      for (const oid of [previous, previousRecord.head, previousRecord.main, approvedHead]) {
        f.git(["cat-file", "-e", `${oid}^{commit}`]);
      }
      expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(previousRecord);
      if (replacement) {
        expectCapturedFiles(f, captures, successor);
      }
    },
  );

  const retainedIntentFaults = new Set(
    "stale-outcome accepted auto-route queue-route admin-route".split(" "),
  );

  it.each(
    (
      "stale-outcome accepted auto-route queue-route admin-route review checks pending " +
      "current-queue current-admin prepared-head method operator successor no-net-change " +
      "wrong-pr wrong-repo current-auto current-queued"
    )
      .split(" ")
      .flatMap((fault) =>
        (fault === "prepared-head" ? [false, true] : [true]).map((replacement) => ({
          fault,
          replacement,
        })),
      ),
  )("refuses $fault recovery (replacement=$replacement)", ({ fault, replacement }) => {
    const f = fixture();
    const initial = f.state();
    initial.mode = fault === "accepted" ? "pending" : "unapplied";
    applyFault(fault, {
      "auto-route": () => (initial.pr.mergeStateStatus = "BEHIND"),
      "queue-route": () => (initial.pr.isMergeQueueEnabled = true),
    });
    if (fault === "admin-route") {
      initial.admin = true;
      initial.gates = "fail";
    }
    f.save(initial);
    const accepted = fault === "accepted";
    const { previous, captures } = retainIntent(f, accepted ? 0 : 1, fault === "auto-route");
    f.recover();
    const approvedHead = replacement ? f.replacePreparedHead() : "";
    const next = { ...f.state(), mode: "success", admin: false, gates: "pass" };
    next.pr.autoMergeRequest = null;
    next.pr.isInMergeQueue = false;
    next.pr.isMergeQueueEnabled = false;
    next.pr.mergeStateStatus = "CLEAN";
    applyFault(fault, {
      "wrong-pr": () => (next.pr.id = "other-pr"),
      "wrong-repo": () => (next.repoAuthority.node_id = "other-repo"),
      "current-auto": () => (next.pr.autoMergeRequest = { mergeMethod: "SQUASH" }),
      "current-queued": () => (next.pr.isInMergeQueue = true),
      review: () => (next.review = false),
      checks: () => (next.gates = "fail"),
      pending: () => (next.gates = "pending"),
      "current-queue": () => (next.pr.isMergeQueueEnabled = true),
      "current-admin": () => Object.assign(next, { admin: true, gates: "fail" }),
      operator: () => (next.operator = ""),
      successor: () => (next.crash = "successor"),
      "no-net-change": () =>
        f.advance(replacement ? "reviewed replacement\n" : "after\n", "stable\n"),
    });
    if (fault === "prepared-head") {
      next.pr.headRefOid = f.base;
      f.git(["-C", f.worktree, "checkout", "--detach", f.base]);
      writeLocal(
        f,
        "prep.env",
        `PREP_HEAD_SHA=${f.base}\nLOCAL_PREP_HEAD_SHA=${f.base}\nPREP_MAINLINE_BASE_SHA=${f.base}\n`,
      );
    }
    f.save(next);
    const result = expectExit(
      f.run(
        false,
        f.repo,
        fault === "method" ? "merge" : "squash",
        fault === "stale-outcome" ? f.base : previous,
        approvedHead,
      ),
      1,
    );
    if (retainedIntentFaults.has(fault)) {
      expect(result.output).toContain(
        "operator recovery requires an exact unaccepted immediate intent, confirmed auto cancellation, or explicitly auto-routed stale admin head; no attempt was authorized",
      );
    }
    expectNoDispatch(f, result.output);
    expect(f.captures()).toEqual(captures);
    if (fault === "successor") {
      expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    } else {
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    }
  });

  it.each(Object.entries(replacementFaults))("rejects evidence: %s", (fault, corrupt) => {
    const f = configuredFixture(fixture, { mode: "unapplied" });
    const { previous, captures } = retainIntent(f, 1);
    f.recover();
    const approvedHead = f.replacePreparedHead();
    configureMerge(f, { mode: "success" });
    corrupt(f, approvedHead);
    const approval =
      fault === "missing-approval"
        ? ""
        : fault === "wrong-approval"
          ? f.head
          : fault === "malformed-approval"
            ? "HEAD"
            : approvedHead;
    const run = expectRecovery(f, previous, approval, fault === "malformed-approval" ? 2 : 1);
    expectNoDispatch(f, run.output);
    expectRetained(f, previous, captures);
  });

  it.each([false, true])("rejects capture symlinks (target exists=%s)", (exists) => {
    const f = configuredFixture(fixture, { crash: "capture" });
    const target = join(f.root, "capture-target");
    if (exists) {
      writeFileSync(target, "existing capture sentinel\n");
    }
    const run = expectExit(f.run(), 1);
    expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    expect(f.record()).toMatchObject({ phase: "intent", accepted: false });
    expect(run.output).not.toContain("existing capture sentinel");
    expect(existsSync(target)).toBe(exists);
    if (exists) {
      expect(readFileSync(target, "utf8")).toBe("existing capture sentinel\n");
    }
    f.recover();
    expect(f.run().status).toBe(1);
    expect(f.state().mutations).toBe(0);
  });
});
