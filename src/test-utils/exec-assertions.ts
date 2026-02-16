import { expect } from "vitest";

export function expectSingleNpmInstallIgnoreScriptsCall(params: {
  calls: Array<[unknown, { cwd?: string } | undefined]>;
  expectedCwd: string;
}) {
  const npmCalls = params.calls.filter((call) => Array.isArray(call[0]) && call[0][0] === "npm");
  expect(npmCalls.length).toBe(1);
  const first = npmCalls[0];
  if (!first) {
    throw new Error("expected npm install call");
  }
  const [argv, opts] = first;
  expect(argv).toEqual(["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"]);
  expect(opts?.cwd).toBe(params.expectedCwd);
}
