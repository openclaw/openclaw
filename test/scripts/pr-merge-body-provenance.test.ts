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

  it.each(["tamper", "head", "queue", "merge", "review"])(
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
      if (fault === "review") {
        state.ready = false;
      }
      f.save(state);
      const result = f.run(false, f.repo, fault === "merge" ? "merge" : "squash", "", "", body);
      expect(result.status, result.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
    },
  );

  it.each([
    {
      route: "immediate",
      access: "external",
      auto: false,
      admin: false,
      queue: false,
      mergeStateStatus: "CLEAN",
    },
    {
      route: "auto",
      access: "unknown",
      auto: true,
      admin: false,
      queue: false,
      mergeStateStatus: "BEHIND",
    },
    {
      route: "queue",
      access: "external",
      auto: false,
      admin: false,
      queue: true,
      mergeStateStatus: "CLEAN",
    },
    {
      route: "admin",
      access: "unknown",
      auto: false,
      admin: true,
      queue: false,
      mergeStateStatus: "BLOCKED",
    },
  ])(
    "blocks rewritten $access squash before $route intent",
    ({ access, auto, admin, queue, mergeStateStatus }) => {
      const f = fixture();
      f.setPrivacyProvenance("true", access);
      f.save({
        ...f.state(),
        admin,
        gates: admin ? "fail" : "pass",
        pr: { ...f.state().pr, isMergeQueueEnabled: queue, mergeStateStatus },
      });

      const run = f.run(auto);

      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain("maintainer-owned replacement PR");
      expect(f.state().mutations).toBe(0);
      expect(f.captures()).toEqual([]);
      expect(() => f.record()).toThrow();
    },
  );

  it.each([
    { rewrite: "true", access: "maintainer" },
    { rewrite: "false", access: "unknown" },
  ])("allows squash with valid privacy provenance: %j", ({ rewrite, access }) => {
    const f = fixture();
    f.setPrivacyProvenance(rewrite, access);

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record().phase).toBe("complete");
  });

  it.each([
    ["missing", "PREP_REPLACED_HOSTED_ANCESTRY=false\n"],
    [
      "malformed rewrite",
      "PREP_REPLACED_HOSTED_ANCESTRY=false",
      "PREP_REPLACED_HOSTED_ANCESTRY=yes",
    ],
    ["malformed access", "PREP_AUTHOR_ACCESS=external", "PREP_AUTHOR_ACCESS=write"],
  ])("requires prepare rerun for %s squash provenance", (_label, from, to = "") => {
    const f = fixture();
    const prepPath = join(f.worktree, ".local/prep.env");
    writeFileSync(prepPath, readFileSync(prepPath, "utf8").replace(from, to));

    const run = f.run();

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("scripts/pr prepare-run");
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each(["merge", "rebase"])("leaves %s mechanics independent of squash provenance", (method) => {
    const f = fixture();
    f.setPrivacyProvenance(null, null);

    const run = f.run(false, f.repo, method);

    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

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
    { auto: false, admin: false, mergeState: "CLEAN", route: "immediate" },
    { auto: false, admin: false, mergeState: "HAS_HOOKS", route: "immediate" },
    { auto: false, admin: false, mergeState: "UNSTABLE", route: "immediate" },
    { auto: false, admin: true, mergeState: "CLEAN", route: "admin" },
    { auto: false, admin: true, mergeState: "BLOCKED", route: "admin" },
    { auto: false, admin: true, mergeState: "BEHIND", route: "admin" },
    { auto: true, admin: false, mergeState: "BEHIND", route: "auto" },
    { auto: true, admin: false, mergeState: "BLOCKED", route: "auto" },
    { auto: true, admin: false, mergeState: "CLEAN", route: "immediate" },
  ])(
    "submits verified attribution with pinned head for %j",
    ({ auto, admin, mergeState, route }) => {
      const credit = "Co-authored-by: Fixture Contributor <contributor@example.com>";
      const f = fixture(`Source change\n\n${credit}\n`);
      f.save({
        ...f.state(),
        admin,
        gates: admin ? "fail" : "pass",
        pr: { ...f.state().pr, mergeStateStatus: mergeState },
      });
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
      }
      expect(f.state().mergeBody).toBe(`Fixture body\n\n${credit}\n`);
      expect(f.record()).toMatchObject({ route, phase: "complete" });
    },
  );
});
