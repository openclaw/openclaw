import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import type { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

type Fixture = ReturnType<ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"]>;
type State = ReturnType<Fixture["state"]>;
type Changes = Partial<Omit<State, "pr">> & { pr?: Partial<State["pr"]> };
type Local = Pick<Fixture, "worktree">;
type Git = Pick<Fixture, "git">;
type Captures = ReadonlyArray<readonly [string, string]>;
type RetainedCaptures = ReturnType<Fixture["captures"]>;
type Result = { status: number | null; output: string };
type PriorCandidate = ReturnType<
  ReturnType<typeof createPriorCiCandidateFactory>["preExistingCandidate"]
>;

export function expectPriorCiRefusal(
  f: Pick<PriorCandidate, "verifyPriorCi" | "path" | "state">,
  message: string | RegExp,
) {
  const result = f.verifyPriorCi(f.path);
  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toMatch(message);
  expect(f.state().mutations).toBe(0);
}

export const readLocal = (f: Local, name: string) =>
  readFileSync(join(f.worktree, ".local", name), "utf8");

export const writeLocal = (f: Local, name: string, contents: string) =>
  writeFileSync(join(f.worktree, ".local", name), contents);

export const pendingGates = (f: Local & Pick<Fixture, "head">, head = f.head) =>
  writeLocal(
    f,
    "gates.env",
    `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${head}\n`,
  );

export function retainIntent(f: Fixture, code = 1, auto = false) {
  expectExit(f.run(auto), code);
  return {
    previous: f.git(["rev-parse", "refs/openclaw/pr-merge-outcomes/123"]),
    previousRecord: f.record(),
    captures: f.captures(),
  };
}

export function expectRecovery(f: Fixture, outcome: string, head = "", code = 0, auto = false) {
  return expectExit(f.run(auto, f.repo, "squash", outcome, head), code);
}

export function expectGraphqlSquash(f: Fixture, commitBody: string | null) {
  expect(f.state().graphqlMergePayloads).toEqual([
    { pullRequestId: "fixture-pr", expectedHeadOid: f.head, mergeMethod: "SQUASH", commitBody },
  ]);
}

export function expectPinnedMerge(f: Fixture, route: string) {
  const state = f.state();
  const submissions = state.calls.filter((call) => call[1] === "pr" && call[2] === "merge");
  expect(submissions).toHaveLength(route === "immediate" ? 0 : 1);
  if (route === "immediate") {
    expect(state.graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
    return;
  }
  const args = submissions[0]!;
  expect(args[args.indexOf("--match-head-commit") + 1]).toBe(f.head);
  expect(args.includes("--auto")).toBe(route === "auto");
  expect(args.includes("--admin")).toBe(route === "admin");
  expect(args).toContain("--subject");
  expect(args[args.indexOf("--subject") + 1]).toBe(state.previewHeadline);
}

export function observeMerged(f: Fixture, landed: string, changes: Changes = {}) {
  configureMerge(f, {
    ...changes,
    pr: { state: "MERGED", mergeCommit: { oid: landed }, ...changes.pr },
  });
}

export function expectRetained(f: Fixture, previous: string, captures: RetainedCaptures) {
  expect(f.git(["rev-parse", "refs/openclaw/pr-merge-outcomes/123"])).toBe(previous);
  expect(f.captures()).toEqual(captures);
}

export function completedStep(
  number: number,
  name: string,
  conclusion: string,
  started_at?: string,
  completed_at?: string,
) {
  return { number, name, status: "completed", conclusion, started_at, completed_at };
}

export function expectExit<T extends Result>(result: T, code = 0) {
  expect(result.status, result.output).toBe(code);
  return result;
}

export function applyFault(fault: string, mutations: Record<string, () => unknown>) {
  mutations[fault]?.();
}

export function configureMerge(f: Pick<Fixture, "state" | "save">, changes: Changes) {
  const state = f.state();
  f.save({ ...state, ...changes, pr: { ...state.pr, ...changes.pr } });
}

export function configuredFixture<T extends Fixture>(create: () => T, changes: Changes): T {
  const f = create();
  configureMerge(f, changes);
  return f;
}

export function expectCapturedFiles(f: Git, captures: Captures, ref: string) {
  for (const [name, bytes] of captures) {
    expect(f.git(["rev-parse", `${ref}:${name}`])).toBe(f.git(["hash-object", "--stdin"], bytes));
  }
}

export function expectAncestors(f: Git, ancestors: string[], ref: string) {
  for (const ancestor of ancestors) {
    expect(f.git(["merge-base", "--is-ancestor", ancestor, ref])).toBe("");
  }
}
