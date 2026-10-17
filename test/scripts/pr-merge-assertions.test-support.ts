import { expect } from "vitest";
import type { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

type Fixture = ReturnType<ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"]>;
type State = ReturnType<Fixture["state"]>;
type Changes = Partial<Omit<State, "pr">> & { pr?: Partial<State["pr"]> };

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
  ref = "refs/openclaw/pr-merge-outcomes/123",
) {
  for (const [name, bytes] of captures) {
    expect(f.git(["rev-parse", `${ref}:${name}`])).toBe(f.git(["hash-object", "--stdin"], bytes));
  }
}

export function expectAncestors(
  f: Pick<Fixture, "git">,
  ancestors: string[],
  ref = "refs/openclaw/pr-merge-outcomes/123",
) {
  for (const ancestor of ancestors) {
    expect(f.git(["merge-base", "--is-ancestor", ancestor, ref])).toBe("");
  }
}
