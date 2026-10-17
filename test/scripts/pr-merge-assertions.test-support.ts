import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import type { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

type Fixture = ReturnType<ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"]>;
type State = ReturnType<Fixture["state"]>;
type Changes = Partial<Omit<State, "pr">> & { pr?: Partial<State["pr"]> };
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

export function readLocal(f: Pick<Fixture, "worktree">, name: string) {
  return readFileSync(join(f.worktree, ".local", name), "utf8");
}

export function writeLocal(f: Pick<Fixture, "worktree">, name: string, contents: string) {
  writeFileSync(join(f.worktree, ".local", name), contents);
}

export function pendingGates(f: Pick<Fixture, "worktree" | "head">, head = f.head) {
  writeLocal(
    f,
    "gates.env",
    `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${head}\n`,
  );
}

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

export function observeMerged(f: Fixture, landed: string, changes: Changes = {}) {
  configureMerge(f, {
    ...changes,
    pr: { state: "MERGED", mergeCommit: { oid: landed }, ...changes.pr },
  });
}

export function expectRetained(
  f: Fixture,
  previous: string,
  captures: ReturnType<Fixture["captures"]>,
) {
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

export function expectExit<T extends { status: number | null; output: string }>(
  result: T,
  code = 0,
) {
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

export function configuredFixture(create: () => Fixture, changes: Changes) {
  const f = create();
  configureMerge(f, changes);
  return f;
}

export function expectCapturedFiles(
  f: Pick<Fixture, "git">,
  captures: ReadonlyArray<readonly [string, string]>,
  ref: string,
) {
  for (const [name, bytes] of captures) {
    expect(f.git(["rev-parse", `${ref}:${name}`])).toBe(f.git(["hash-object", "--stdin"], bytes));
  }
}

export function expectAncestors(f: Pick<Fixture, "git">, ancestors: string[], ref: string) {
  for (const ancestor of ancestors) {
    expect(f.git(["merge-base", "--is-ancestor", ancestor, ref])).toBe("");
  }
}
