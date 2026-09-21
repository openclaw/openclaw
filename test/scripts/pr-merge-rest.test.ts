import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix, unknownProjection } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge with exhausted GraphQL quota", () => {
  function restFixture(...args: Parameters<typeof fixture>) {
    const f = fixture(...args);
    f.save({ ...f.state(), restPolicy: "supported" });
    return f;
  }

  it("uses one pinned REST PUT for ordinary squash without GraphQL reads", () => {
    const f = restFixture();

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
    expect(f.state().restMergePayload).not.toHaveProperty("commit_title");
    expect(f.state().calls.filter((call) => call.includes("PUT"))).toHaveLength(1);
    expect(
      f
        .state()
        .calls.some((call) => call.includes("graphql") || (call[1] === "pr" && call[2] !== "view")),
    ).toBe(false);
  });

  it("switches exhausted REST reads to one pinned GraphQL merge", () => {
    const f = restFixture();
    f.save({ ...f.state(), restReadFailure: "core", restReadFailuresRemaining: 1 });

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.record()).not.toHaveProperty("transport");
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toBeNull();
    expect(f.state().graphqlMergePayloads).toEqual([
      {
        pullRequestId: "fixture-pr",
        expectedHeadOid: f.head,
        mergeMethod: "SQUASH",
        commitBody: f.state().mergeBody,
      },
    ]);
    expect(f.state().calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
  });

  it.each(["core", "secondary", "access"])(
    "does not dispatch after REST %s failure without an available alternate",
    (failure) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        restReadFailure: failure,
        restReadFailuresRemaining: 1,
        quotaAt: "checks",
      });

      const run = f.run();

      expect(run.status, run.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
      const fallbackChecks = f
        .state()
        .calls.filter((call) => call[1] === "pr" && call[2] === "checks");
      expect(fallbackChecks).toHaveLength(failure === "core" ? 1 : 0);
      if (failure === "core") {
        expect(run.output).toContain("Neither GitHub transport");
      }
    },
  );

  it.each(["preview", "observe"])(
    "completes pinned REST squash after quota exhaustion during %s and preserves human credit",
    (quotaAt) => {
      const f = restFixture(
        "Repair\n\nCo-authored-by: Source <source@example.com>\nCo-authored-by: Codex <codex@openai.com>",
        undefined,
        false,
        { name: "Contributor", email: "contributor@example.com" },
      );
      f.save({ ...f.state(), quotaAt, restReadFailure: "core", restReadFailuresRemaining: 1 });

      const run = f.run();

      expect(run.status, run.output).toBe(0);
      expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
      expect(f.state().mergeBody).toContain(
        "Co-authored-by: Contributor <contributor@example.com>",
      );
      expect(f.state().mergeBody).toContain("Co-authored-by: Source <source@example.com>");
      expect(f.state().mergeBody).not.toContain("codex@openai.com");
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(f.state().calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each(["none", "head", "lifecycle", "main"])(
    "settles UNKNOWN GraphQL mergeability through REST without hiding %s drift",
    (drift) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        quotaAt: "observe",
        quotaAfterObservations: 1,
        restReadFailure: "core",
        restReadFailuresRemaining: 1,
        observations: [{ pr: unknownProjection }],
        restObservation: {
          pr: {
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            ...(drift === "head" ? { headRefOid: f.base } : {}),
            ...(drift === "lifecycle" ? { state: "CLOSED" } : {}),
          },
          advanceMain: drift === "main",
        },
      });

      const run = f.run();

      expect(run.status, run.output).toBe(["none", "main"].includes(drift) ? 0 : 1);
      expect(f.state().observationReads).toBe(1);
      expect(f.state().mutations).toBe(["none", "main"].includes(drift) ? 1 : 0);
      if (["none", "main"].includes(drift)) {
        expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it.each(["before-evidence", "during-evidence"] as const)(
    "lands ordinary REST squash when main advances %s at dispatch",
    (boundary) => {
      const f = restFixture();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      f.save({
        ...f.state(),
        quotaAt: "checks",
        restMainAdvance: { boundary, observed: false, main },
      });

      const run = f.run();

      expect(run.status, run.output).toBe(0);
      expect(f.record()).toMatchObject({
        phase: "complete",
        transport: "rest",
        head: f.head,
        main: f.base,
      });
      expect(f.state().restMainAdvance).toBeNull();
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
      expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
    },
  );
  it("keeps the prepared squash message when GraphQL depletes during final stability verification", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const f = restFixture(`Repair\n\n${credit}`);
    f.save({
      ...f.state(),
      quotaAt: "observe",
      quotaAfterObservations: 1,
      restReadFailure: "core",
      restReadFailuresRemaining: 1,
    });

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
    expect(f.state().observationReads).toBe(1);
    expect(f.state().mergeBody).toBe(`Fixture body\n\n${credit}\n`);
    expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
    expect(f.state().mutations).toBe(1);
  });

  it("keeps the recomposed body when reads switch from GraphQL through REST and back", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const f = restFixture(`Repair\n\n${credit}`);
    f.save({
      ...f.state(),
      quotaAt: "observe",
      quotaFailuresRemaining: 1,
      restReadFailure: "core",
      restReadFailureAtMainReads: [1, 6],
    });

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.record()).not.toHaveProperty("transport");
    expect(f.state().restReadFailureAtMainReads).toEqual([]);
    expect(f.state().mergeBody).toBe(`Fixture body\n\n${credit}\n`);
    expect(f.state().restMergePayload).toBeNull();
    expect(f.state().mutations).toBe(1);
  });

  it.each(["merge", "rebase", "auto", "admin"])(
    "rejects %s routing when GraphQL depletes only during final stability verification",
    (route) => {
      const f = restFixture();
      const observationsBeforeFinal = route === "auto" ? 1 : 2;
      f.save({
        ...f.state(),
        quotaAt: "observe",
        quotaAfterObservations: observationsBeforeFinal,
        admin: route === "admin",
        gates: route === "admin" ? "fail" : "pass",
        restObservation: { gates: "pass" },
      });
      if (route === "admin") {
        const gates = join(f.worktree, ".local/gates.env");
        writeFileSync(
          gates,
          readFileSync(gates, "utf8").replace("GATES_MODE=full", "GATES_MODE=remote_crabbox_aws"),
        );
      }

      const run = f.run(
        route === "auto",
        f.repo,
        route === "merge" || route === "rebase" ? route : "squash",
      );

      expect(run.status, run.output).toBe(1);
      expect(f.state().observationReads).toBe(observationsBeforeFinal);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );

  it.each(["missing", "classic", "queue", "unsupported", "no-admin"])(
    "rejects %s branch policy before recording a REST merge intent",
    (restPolicy) => {
      const f = restFixture();
      const state = f.state();
      if (restPolicy === "no-admin") {
        state.repoAuthority.permissions = { admin: false };
      }
      f.save({ ...state, quotaAt: "checks", restPolicy });

      const run = f.run();

      expect(run.status, run.output).not.toBe(0);
      expect(run.output).toContain(
        restPolicy === "missing" ? "REST merge fallback" : "Neither GitHub transport",
      );
      expect(
        f.state().calls.filter((call) => call[1] === "pr" && call[2] === "checks"),
      ).toHaveLength(restPolicy === "missing" ? 0 : 1);
      expect(f.state().mutations).toBe(0);
      expect(f.state().posts).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );

  it.each([
    { fault: "wrong-ref", afterReads: 0 },
    { fault: "wrong-type", afterReads: 1 },
    { fault: "missing-object", afterReads: 0 },
    { fault: "invalid-sha", afterReads: 1 },
  ])(
    "rejects $fault main reference evidence after $afterReads valid reads",
    ({ fault, afterReads }) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        quotaAt: "checks",
        restMainFault: fault,
        restMainFaultAfterReads: afterReads,
      });

      const run = f.run();

      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain("REST merge fallback: main is unavailable");
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );

  it.each([
    { contexts: ["CI / checks? & +"], failedContext: "", admitted: true },
    { contexts: ["CI", "Quality"], failedContext: "", admitted: true },
    { contexts: ["CI", "Quality"], failedContext: "Quality", admitted: false },
  ])(
    "preserves all required contexts $contexts with failing context '$failedContext'",
    ({ contexts, failedContext, admitted }) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        quotaAt: "checks",
        restContexts: contexts,
        restFailedContext: failedContext,
      });

      const run = f.run();

      expect(run.status, run.output).toBe(admitted ? 0 : 1);
      expect(f.state().mutations).toBe(admitted ? 1 : 0);
      const requests = f
        .state()
        .calls.flatMap((call) =>
          call.filter(
            (arg) => arg.startsWith("repos/fixture/repo/commits/") && arg.includes("/check-runs?"),
          ),
        )
        .map((endpoint) => new URL(endpoint, "https://github.com"));
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) =>
            request.searchParams.get("check_name") === (contexts.length === 1 ? contexts[0] : null),
        ),
      ).toBe(true);
      if (admitted) {
        expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it("accepts an app-bound required check alongside a successful same-name legacy status", () => {
    const f = restFixture();
    f.save({ ...f.state(), quotaAt: "checks", restChecks: "bound-status" });

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    "missing",
    "status-only",
    "wrong-app",
    "wrong-app-status",
    "failed",
    "failed-status",
    "inconsistent-status",
  ])("does not admit REST merge with %s required-check evidence", (fault) => {
    const f = restFixture();
    f.save({
      ...f.state(),
      quotaAt: "checks",
      restChecks: fault,
      restCheckApp: fault.startsWith("wrong-app") ? 999 : 15368,
      gates: fault === "failed" ? "fail" : "pass",
    });

    const run = f.run();

    expect(run.status, run.output).not.toBe(0);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each([
    { restDuplicate: "same-workflow", admitted: true },
    { restDuplicate: "other-workflow", admitted: false },
    { restDuplicate: "other-event", admitted: false },
    { restDuplicate: "missing-mapping", admitted: false },
    { restDuplicate: "ambiguous-mapping", admitted: false },
    { restDuplicate: "same-time", admitted: false },
    { restDuplicate: "missing-time", admitted: false },
  ])(
    "preserves required-check rerun identity for $restDuplicate",
    ({ restDuplicate, admitted }) => {
      const f = restFixture();
      f.save({ ...f.state(), quotaAt: "checks", restDuplicate });

      const run = f.run();

      expect(run.status, run.output).toBe(admitted ? 0 : 1);
      expect(f.state().mutations).toBe(admitted ? 1 : 0);
      if (admitted) {
        expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it("rejects a successful required check while its suite is rerunning", () => {
    const f = restFixture();
    f.save({ ...f.state(), quotaAt: "checks", restSuite: "rerunning" });

    const run = f.run();

    expect(run.status, run.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each([
    { restUnseenSuite: "pending", admitted: false },
    { restUnseenSuite: "failed", admitted: false },
    { restUnseenSuite: "partial-pending", admitted: false },
    { restUnseenSuite: "other-app", admitted: true },
    { restUnseenSuite: "labeler", admitted: true },
    { restUnseenSuite: "hidden-skipped", admitted: false },
    { restUnseenSuite: "irrelevant-failure", admitted: true },
    { restUnseenSuite: "changed-suite", admitted: false },
    { restUnseenSuite: "incomplete-suite", admitted: false },
    { restUnseenSuite: "missing-version", admitted: false },
    { restUnseenSuite: "missing-count", admitted: false },
    { restUnseenSuite: "changed-count", admitted: false },
    { restUnseenSuite: "queued-empty-unbound", restRequiredApp: null, admitted: true },
    { restUnseenSuite: "queued-empty-custom", restRequiredApp: 45678, admitted: true },
    { restUnseenSuite: "queued-empty-drift", admitted: false },
  ])(
    "checks fresh $restUnseenSuite suites missing from the earlier check-run snapshot",
    ({ restUnseenSuite, admitted, restRequiredApp = 15368 }) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        quotaAt: "checks",
        restUnseenSuite,
        restRequiredApp,
        restCheckApp: restRequiredApp ?? 15368,
      });

      const run = f.run();

      expect(run.status, run.output).toBe(admitted ? 0 : 1);
      expect(f.state().mutations).toBe(admitted ? 1 : 0);
      if (admitted) {
        expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it.each(["auto", "merge", "rebase", "admin"])(
    "does not silently change the requested %s route to REST squash",
    (route) => {
      const f = restFixture();
      f.save({
        ...f.state(),
        quotaAt: "checks",
        admin: route === "admin",
        gates: route === "admin" ? "fail" : "pass",
      });
      if (route === "admin") {
        const gates = join(f.worktree, ".local/gates.env");
        writeFileSync(
          gates,
          readFileSync(gates, "utf8").replace("GATES_MODE=full", "GATES_MODE=remote_crabbox_aws"),
        );
      }

      const run = f.run(
        route === "auto",
        f.repo,
        route === "merge" || route === "rebase" ? route : "squash",
      );

      expect(run.status, run.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );

  it.each([
    "supported",
    "classic",
    "queue",
    "unsupported",
    "no-admin",
    "main-advance",
    "open-main-advance",
  ])(
    "reconciles a lost REST merge reply after policy changes to %s without submitting another mutation",
    (restPolicy) => {
      const f = restFixture();
      f.save({ ...f.state(), quotaAt: "checks", mode: "applied-open" });
      const first = f.run();
      expect(first.status, first.output).toBe(1);
      expect(f.record()).toMatchObject({ phase: "intent", transport: "rest", accepted: false });
      expect(f.state().mutations).toBe(1);
      const intent = f.git(["rev-parse", outcomeRef]);
      const captures = f.captures();
      const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
      f.recover();
      const state = f.state();
      if (restPolicy === "no-admin") {
        state.repoAuthority.permissions = { admin: false };
      }
      if (restPolicy === "open-main-advance") {
        state.restMainAdvance = {
          boundary: "during-evidence",
          observed: false,
          main: f.commit(
            f.git(["rev-parse", `${landed}^{tree}`]),
            [landed],
            "Open receipt advance\n",
          ),
        };
      }
      f.save({ ...state, restPolicy });

      const unresolved = f.run();
      expect(unresolved.status, unresolved.output).toBe(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(intent);
      expect(f.captures()).toEqual(captures);
      expect(f.state().mutations).toBe(1);
      if (restPolicy === "open-main-advance") {
        expect(f.state().restMainAdvance).toBeNull();
        expect(unresolved.output).toContain("main changed while reading evidence");
      }
      f.recover();
      f.save({
        ...f.state(),
        gates: "fail",
        restAdvanceMain: restPolicy === "main-advance",
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });

      const resumed = f.run();

      expect(resumed.status, resumed.output).toBe(0);
      expect(f.record()).toMatchObject({
        phase: "merged",
        transport: "rest",
        landed,
        head: f.head,
      });
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(f.state().mainAdvances).toHaveLength(restPolicy === "main-advance" ? 1 : 0);
    },
  );

  it("never replays an exhausted GraphQL mutation through REST", () => {
    const f = fixture();
    f.save({ ...f.state(), quotaAt: "mutation" });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    const intent = f.git(["rev-parse", outcomeRef]);
    expect(f.record()).toMatchObject({ phase: "intent", accepted: false });
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toBeNull();
    f.recover();

    const resumed = f.run();

    expect(resumed.status, resumed.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(intent);
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toBeNull();
  });
});
