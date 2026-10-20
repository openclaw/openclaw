import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("snapshots corrected squash prose once and retains source and server coauthors", () => {
    const source = "Co-authored-by: Source <source@example.com>";
    const server = "Co-authored-by: Server <server@example.com>";
    const f = fixture(`Repair\n\n${source}`, undefined, false, {
      name: "Server",
      email: "server@example.com",
    });
    const body = join(f.repo, "operator body.md");
    writeFileSync(body, "Partial repair. Related: #42.\n");
    f.save({
      ...f.state(),
      previewBody: `Fixes #42\n\n${server}`,
      duringChecks: { bodyPath: body },
    });
    const result = f.run(false, f.repo, "squash", "", "", body);
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(body, "utf8")).toBe("Changed later");
    expect(f.state().mergeBody).toBe(`Partial repair. Related: #42.\n\n${server}\n${source}\n`);
    expect(f.state().mutations).toBe(1);
    expect(f.state().graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
  });

  it.each(["tamper", "head", "queue", "merge"])(
    "keeps explicit body admission closed for %s",
    (fault) => {
      const f = fixture();
      const body = join(f.repo, "body.md");
      writeFileSync(body, "Corrected prose");
      const state = f.state();
      if (fault === "tamper") {
        state.tamperMergeBody = true;
      }
      if (fault === "head") {
        state.duringChecks = { head: "a".repeat(40) };
      }
      if (fault === "queue") {
        state.observations = [{ pr: { isMergeQueueEnabled: true } }];
      }
      f.save(state);
      const result = f.run(false, f.repo, fault === "merge" ? "merge" : "squash", "", "", body);
      expect(result.status, result.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
    },
  );

  it.each([
    ["true", "external", "squash", "replacement"],
    ["true", "unknown", "squash", "replacement"],
    ["true", "maintainer", "squash", "complete"],
    ["false", "unknown", "squash", "complete"],
    [null, "external", "squash", "prepare"],
    ["false", "write", "squash", "prepare"],
    [null, null, "merge", "merge"],
  ] as const)(
    "checks rewrite=%s author=%s for %s provenance: %s",
    (rewrite, access, method, outcome) => {
      const f = fixture();
      f.setPrivacyProvenance(rewrite, access);
      const run = f.run(false, f.repo, method);
      const rejected = outcome === "replacement" || outcome === "prepare";
      expect(run.status, run.output).toBe(rejected ? 1 : 0);
      expect(f.state().mutations).toBe(rejected ? 0 : 1);
      if (rejected) {
        expect(run.output).toContain(
          outcome === "replacement" ? "maintainer-owned replacement PR" : "scripts/pr prepare-run",
        );
        expect(() => f.record()).toThrow();
      }
      if (outcome === "replacement") {
        expect(f.captures()).toEqual([]);
      } else if (outcome === "complete") {
        expect(f.record().phase).toBe("complete");
      }
    },
  );

  it("reconciles a prior outcome before reading squash privacy provenance", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    f.setPrivacyProvenance(null, null);

    const retry = f.run();

    expect(retry.status, retry.output).toBe(1);
    expect(retry.output).not.toContain("scripts/pr prepare-run");
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    { auto: false, admin: false, mergeState: "HAS_HOOKS", route: "immediate" },
    { auto: false, admin: true, mergeState: "BLOCKED", route: "admin" },
    { auto: true, admin: false, mergeState: "BEHIND", route: "auto" },
    { auto: true, admin: false, mergeState: "CLEAN", route: "immediate", pendingGates: true },
  ])(
    "submits verified attribution with pinned head for %j",
    ({ auto, admin, mergeState, route, pendingGates }) => {
      const credit = "Co-authored-by: Fixture Contributor <contributor@example.com>";
      const f = fixture(`Source change\n\n${credit}\n`);
      f.save({
        ...f.state(),
        admin,
        ...(pendingGates ? { requiredCheckName: "openclaw/ci-gate" } : {}),
        gates: admin ? "fail" : "pass",
        pr: { ...f.state().pr, mergeStateStatus: mergeState },
      });
      if (pendingGates) {
        writeFileSync(
          join(f.worktree, ".local/gates.env"),
          `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
        );
      }
      const run = f.run(auto);
      expect(run.status, run.output).toBe(0);
      const submissions = f.state().calls.filter((call) => call[1] === "pr" && call[2] === "merge");
      if (route === "immediate") {
        expect(submissions).toHaveLength(0);
        expect(f.state().graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
      } else {
        expect(submissions).toHaveLength(1);
        const args = submissions[0]!;
        expect(args[args.indexOf("--match-head-commit") + 1]).toBe(f.head);
        expect(args.includes("--auto")).toBe(route === "auto");
        expect(args.includes("--admin")).toBe(admin);
        expect(args).toContain("--subject");
        expect(args[args.indexOf("--subject") + 1]).toBe(f.state().previewHeadline);
      }
      expect(f.state().mergeBody).toBe(`Fixture body\n\n${credit}\n`);
      expect(f.record(), run.output).toMatchObject({ route, phase: "complete" });
    },
  );
  it("rejects a missing auto-merge headline before intent", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      previewHeadline: null,
      pr: { ...f.state().pr, mergeStateStatus: "BEHIND" },
    });
    const run = f.run(true);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(
      "Cannot prepare squash subject: require the current-head merge headline",
    );
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });
});
