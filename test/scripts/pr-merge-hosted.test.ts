import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const outcomeRef = "refs/openclaw/pr-merge-outcomes/42";
const describePosix = process.platform === "win32" ? describe.skip : describe;
type Fixture = ReturnType<typeof createMainRefreshFixture>;
type Event = ReturnType<Fixture["events"]>[number];
const eventIndex = (events: Event[], kind: Event["kind"]) =>
  events.findIndex((event) => event.kind === kind);
const hasEvent = (events: Event[], kind: Event["kind"]) => eventIndex(events, kind) !== -1;
const isMerge = (event: Event) =>
  event.kind === "gh" && event.args?.[0] === "pr" && event.args[1] === "merge";
const isGraphqlMerge = (event: Event) =>
  event.kind === "gh" &&
  event.args?.[0] === "api" &&
  event.args.includes("graphql") &&
  event.args.includes("--input");
const readLocal = (f: Fixture, name: string) => readFileSync(join(f.local, name), "utf8");
const writeGates = (f: Fixture, contents: string) =>
  writeFileSync(join(f.local, "gates.env"), contents);
function observe(f: Fixture, action: () => ReturnType<Fixture["shell"]>, expected = 0) {
  const before = f.events().length;
  const result = action();
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(expected);
  return { ...result, output, events: f.events().slice(before) };
}
const outcomeRecord = (f: Fixture) =>
  JSON.parse(f.git(f.canonical, "show", `${outcomeRef}:outcome.json`));
function expectNoIntent(f: Fixture) {
  expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", outcomeRef)).toBe("");
}
function verify(f: Fixture, autoMergeRequested = false) {
  const options = {
    replacementHead: "",
    autoMergeRequested,
    observation: null,
    qualifiedRefusal: false,
  };
  return f.shell(`merge_verify 42 '${JSON.stringify(options)}' || exit 1`);
}
function checkRow(bucket: "skipping" | "pending" | "pass" | "fail", name = "openclaw/ci-gate") {
  const states = { skipping: "SKIPPED", pending: "PENDING", pass: "SUCCESS", fail: "FAILURE" };
  return { name, bucket, state: states[bucket] };
}

describePosix("native hosted merge handoff", () => {
  let f: ReturnType<typeof createMainRefreshFixture>;
  let preparedGates: string;

  beforeAll(() => {
    f = createMainRefreshFixture(tempDirs.make("openclaw-pr-merge-hosted-"));
    f.configure({ hostedCi: "release" });
    observe(f, () => f.run("prepare-run"));
    preparedGates = readLocal(f, "gates.env");
    delete f.env.OPENCLAW_TESTBOX;
    // Neither unrelated checkout changes nor a PR-controlled verifier may replace prepared proof.
    f.git(f.worktree, "checkout", "--detach", f.main);
    writeFileSync(join(f.worktree, "CHANGELOG.md"), "Unrelated changelog-only checkout.\n");
    f.git(f.worktree, "add", "CHANGELOG.md");
    f.git(f.worktree, "commit", "-qm", "docs: unrelated changelog-only checkout");
    writeFileSync(
      join(f.worktree, "scripts/verify-pr-hosted-gates.mts"),
      "throw new Error('PR helper executed');\n",
    );
  });

  beforeEach(() => {
    // Only the final case may consume the shared preparation by merging.
    f.configure({ hostedCi: "release", requiredChecks: "pass" });
    writeGates(f, preparedGates);
    rmSync(join(f.local, "merge-checks-watch.log"), { force: true });
  });

  it.each(["missing-artifact", "missing", "required-fail", "required-pending"] as const)(
    "blocks %s evidence before merge dispatch in an OR-list caller",
    (fault) => {
      const requiredFaults: Partial<Record<string, "fail" | "pending" | "api-error">> = {
        "required-fail": "fail",
        "required-pending": "pending",
      };
      const requiredChecks = requiredFaults[fault];
      if (requiredChecks) {
        f.configure({ requiredChecks });
      } else if (fault === "missing") {
        f.configure({ hostedCi: fault });
      } else {
        rmSync(join(f.local, "gates.env"));
      }
      const savedProof = readLocal(f, "gates-hosted-checks.json");
      const { events } = observe(f, () => f.shell("merge_run 42 || exit 1"), 1);
      expect(hasEvent(events, "ci-watched")).toBe(false);
      if (requiredChecks) {
        expect(eventIndex(events, "required-checks")).toBeGreaterThan(
          eventIndex(events, "hosted-gate"),
        );
      } else if (fault === "missing") {
        expect(hasEvent(events, "required-checks")).toBe(false);
        expect(readLocal(f, "gates-hosted-checks.json")).toBe(savedProof);
      }
      expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
      expectNoIntent(f);
    },
  );

  it.each(["full", "remote_crabbox_aws"])("retains the PR CI wait for %s preparation", (mode) => {
    f.configure({ hostedCi: "scheduled" });
    writeGates(f, preparedGates.replace("hosted_exact_or_recent_parent", mode));
    const { events } = observe(f, () => verify(f));
    const watched = eventIndex(events, "ci-watched");
    expect(watched).toBeGreaterThanOrEqual(0);
    expect(eventIndex(events, "required-checks")).toBeGreaterThan(watched);
    expect(hasEvent(events, "hosted-gate")).toBe(false);
  });

  it("dispatches once with the exact prepared head and ordinary server enforcement", () => {
    const { output, events } = observe(f, () => f.run("merge-run"));
    const mergeCalls = f.events().filter(isGraphqlMerge);
    expect(mergeCalls).toHaveLength(1);
    const hosted = eventIndex(events, "hosted-gate");
    expect(hosted).toBeGreaterThanOrEqual(0);
    expect(eventIndex(events, "required-checks")).toBeGreaterThan(hosted);
    expect(hasEvent(events, "ci-watched")).toBe(false);
    expect(events.some(isMerge)).toBe(false);
    expect(f.git(f.origin, "log", "-1", "--format=%B", "main")).toBe(
      "Fixture squash\n\nReviewed fixture body",
    );
    expect(outcomeRecord(f)).toMatchObject({
      head: f.head,
      route: "immediate",
      phase: "commented",
    });
    // The deliberately modified PR helper is unfinished local work, not disposable proof.
    expect(existsSync(f.worktree)).toBe(true);
    expect(readFileSync(join(f.worktree, "scripts/verify-pr-hosted-gates.mts"), "utf8")).toBe(
      "throw new Error('PR helper executed');\n",
    );
    expect(output).toContain("worktree has local changes or is locked");
  });
});

describePosix("native pending GitHub merge handoff", () => {
  let f: ReturnType<typeof createMainRefreshFixture>;
  let pendingGates: string;

  beforeAll(() => {
    f = createMainRefreshFixture(tempDirs.make("openclaw-pr-merge-pending-"));
    delete f.env.OPENCLAW_TESTBOX;
    f.env.OPENCLAW_PR_GATES_REMOTE = "github";
    f.configure({
      hostedCi: "missing",
      requiredChecks: "pending",
      metadata: { ...f.metadata, mergeStateStatus: "BLOCKED" },
    });
    observe(f, () => f.run("prepare-run"));
    pendingGates = readLocal(f, "gates.env");
  });

  beforeEach(() => {
    f.configure({ requiredChecks: "pending", requiredCheckRows: undefined });
    writeGates(f, pendingGates);
  });

  it.each([
    "missing auto request",
    "different gate head",
    "replacement recovery",
    "REST transport",
    "missing required gate",
  ] as const)("rejects %s before pending admission", (fault) => {
    const verification = {
      replacementHead: fault === "replacement recovery" ? f.head : "",
      autoMergeRequested: fault !== "missing auto request",
      observation: null,
      qualifiedRefusal: false,
    };
    let command = `merge_verify 42 '${JSON.stringify(verification)}'`;
    if (fault === "different gate head") {
      writeGates(f, `${pendingGates}\nHOSTED_GATES_TARGET_HEAD_SHA=${f.sameTreeHead}\n`);
    } else if (fault === "REST transport") {
      command = `MERGE_TRANSPORT=rest ${command}`;
    } else if (fault === "missing required gate") {
      f.configure({ requiredChecks: "missing-gate" });
      command = "merge_run 42 true";
    }
    const { events } = observe(f, () => f.shell(`${command} || exit 1`), 1);
    expect(
      events.some((event) => event.kind === "ci-watched" || event.kind === "hosted-gate"),
    ).toBe(false);
    expect(events.some(isMerge)).toBe(false);
    expectNoIntent(f);
  });

  it.each(["pending", "pass"] as const)(
    "admits a skipped draft gate beside the current %s gate",
    (bucket) => {
      f.configure({
        requiredChecks: bucket,
        requiredCheckRows: [checkRow("skipping"), checkRow(bucket)],
      });
      observe(f, () => verify(f, true));
    },
  );

  it.each([
    ["skipped only", [checkRow("skipping")]],
    [
      "unmatched skipped gate",
      [checkRow("pending"), checkRow("skipping", "independent required check")],
    ],
    ["failed current gate", [checkRow("skipping"), checkRow("fail")]],
  ])("rejects %s before auto-merge dispatch", (_name, requiredCheckRows) => {
    f.configure({ requiredCheckRows });
    const { output, events } = observe(f, () => f.shell("merge_run 42 true || exit 1"), 1);
    expect(output).toContain("Required checks are failing");
    expect(events.some((event) => event.kind === "gh" && event.args?.[1] === "merge")).toBe(false);
  });

  it("submits one exact-head auto request and returns pending without polling or cleanup", () => {
    const { stdout, events } = observe(f, () => f.run(["merge-run", "42", "--auto-merge"]));
    expect(stdout).toContain("AUTO/QUEUE PENDING for PR #42; not merged");
    const mergeCalls = events.filter(isMerge);
    expect(mergeCalls).toHaveLength(1);
    const args = mergeCalls[0]?.args ?? [];
    expect(args).toContain("--auto");
    expect(args[args.indexOf("--match-head-commit") + 1]).toBe(f.head);
    expect(events.filter((event) => event.kind === "required-checks")).toHaveLength(1);
    expect(
      events.some((event) => ["ci-watched", "hosted-gate", "leased-cleanup"].includes(event.kind)),
    ).toBe(false);
    expect(events.some((event) => event.kind === "gh" && event.args?.includes("POST"))).toBe(false);
    expect(outcomeRecord(f)).toMatchObject({
      head: f.head,
      route: "auto",
      phase: "intent",
      accepted: true,
      landed: null,
    });
    expect(f.git(f.origin, "rev-parse", "main")).toBe(f.main);
    expect(f.git(f.origin, "rev-parse", "topic")).toBe(f.head);
    expect(existsSync(f.worktree)).toBe(true);
  });
});

describePosix("native superseded-only UNSTABLE merge handoff", () => {
  let f: ReturnType<typeof createMainRefreshFixture>;

  function rollup(replacement: "SUCCESS" | "FAILURE" | null) {
    function check(name: string, conclusion: string, run: number, workflow: number) {
      return {
        kind: "CheckRun" as const,
        databaseId: run * 10,
        name,
        status: "COMPLETED",
        conclusion,
        checkSuite: {
          databaseId: run * 100,
          workflowRun: {
            databaseId: run,
            event: name === "dispatch" ? "pull_request_target" : "pull_request",
            workflow: { databaseId: workflow },
          },
        },
      };
    }
    const nodes = [check("CI", "SUCCESS", 1, 10), check("dispatch", "CANCELLED", 100, 20)];
    if (replacement) {
      nodes.push(check("dispatch", replacement, 200, 20));
    }
    return {
      state: "FAILURE",
      contexts: {
        totalCount: nodes.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes,
      },
    };
  }

  beforeAll(() => {
    f = createMainRefreshFixture(tempDirs.make("openclaw-pr-merge-unstable-"));
    delete f.env.OPENCLAW_TESTBOX;
    f.env.OPENCLAW_PR_GATES_REMOTE = "github";
    f.seedPreparedMerge();
    writeGates(
      f,
      `PR_NUMBER=42\nDOCS_ONLY=false\nCHANGELOG_REQUIRED=false\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
    );
    f.configure({
      metadata: { ...f.metadata, mergeStateStatus: "UNSTABLE" },
      requiredChecks: "pass",
    });
  });

  it.each([
    { fault: "unsuperseded cancellation", replacement: null, hostedCi: "scheduled" },
    { fault: "failing replacement", replacement: "FAILURE", hostedCi: "scheduled" },
    { fault: "unsuccessful ci.yml run", replacement: "SUCCESS", hostedCi: "missing" },
  ] as const)("refuses $fault before intent or dispatch", ({ replacement, hostedCi }) => {
    f.configure({ rollup: rollup(replacement), hostedCi });
    const { output, events } = observe(f, () => f.run(["merge-run", "42", "--auto-merge"]), 1);
    expect(output).toContain(
      "auto-merge admission of MERGEABLE/UNSTABLE requires a GREEN CI watcher pass at the prepared head",
    );
    expect(events.some((event) => isGraphqlMerge(event) || isMerge(event))).toBe(false);
    expectNoIntent(f);
    expect(f.git(f.origin, "rev-parse", "main")).toBe(f.main);
  });

  it("dispatches one immediate exact-head squash after the real watcher exits GREEN", () => {
    f.configure({ rollup: rollup("SUCCESS"), hostedCi: "scheduled" });
    const { events } = observe(f, () => f.run(["merge-run", "42", "--auto-merge"]));
    expect(events.filter(isGraphqlMerge)).toHaveLength(1);
    expect(events.some(isMerge)).toBe(false);
    expect(hasEvent(events, "ci-watched")).toBe(true);
    expect(hasEvent(events, "rollup-read")).toBe(true);
    expect(outcomeRecord(f)).toMatchObject({ head: f.head, route: "immediate", phase: "complete" });
  });
});
