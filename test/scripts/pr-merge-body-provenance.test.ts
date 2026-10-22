import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as proof from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("squash body and provenance", () => {
  it.each(["snapshot", "tamper", "head", "queue", "merge"])("explicit body: %s", (fault) => {
    const snapshot = fault === "snapshot";
    const source = "Co-authored-by: Source <source@example.com>";
    const server = "Co-authored-by: Server <server@example.com>";
    const author = { name: "Server", email: "server@example.com" };
    const f = snapshot ? fixture(`Repair\n\n${source}`, undefined, false, author) : fixture();
    const body = join(f.repo, "operator body.md");
    writeFileSync(body, snapshot ? "Partial repair. Related: #42.\n" : "Corrected prose");
    proof.configureMerge(f, {
      ...(snapshot
        ? { previewBody: `Fixes #42\n\n${server}`, duringChecks: { bodyPath: body } }
        : {}),
      ...(fault === "tamper" ? { tamperMergeBody: true } : {}),
      ...(fault === "head" ? { duringChecks: { head: "a".repeat(40) } } : {}),
      ...(fault === "queue" ? { observations: [{ pr: { isMergeQueueEnabled: true } }] } : {}),
    });
    const method = fault === "merge" ? "merge" : "squash";
    const result = f.run(false, f.repo, method, "", "", body);
    if (!snapshot) {
      expect(result.status, result.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
      return;
    }
    proof.expectExit(result);
    expect(readFileSync(body, "utf8")).toBe("Changed later");
    expect(f.state().mergeBody).toBe(`Partial repair. Related: #42.\n\n${server}\n${source}\n`);
    expect(f.state().mutations).toBe(1);
    expect(f.state().graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
  });

  it.each([
    ["true", "external", "squash", "replacement"],
    ["true", "unknown", "squash", "replacement"],
    ["true", "maintainer", "squash", "complete"],
    ["false", "unknown", "squash", "complete"],
    [null, "external", "squash", "prepare"],
    ["false", "write", "squash", "prepare"],
    [null, null, "merge", "merge"],
  ] as const)("provenance %s/%s/%s: %s", (rewrite, access, method, outcome) => {
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
  });

  it("reconciles a prior outcome before reading squash privacy provenance", () => {
    const f = fixture();
    proof.configureMerge(f, { mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    f.setPrivacyProvenance(null, null);

    const retry = proof.expectExit(f.run(), 1);
    expect(retry.output).not.toContain("scripts/pr prepare-run");
    expect(f.state().mutations).toBe(1);
  });

  it("requires the current-head merge headline", () => {
    const f = proof.configuredFixture(fixture, { previewHeadline: null });
    const run = proof.expectExit(f.run(true), 1);
    expect(run.output).toContain(
      "Cannot prepare squash subject: require the current-head merge headline",
    );
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });
});
