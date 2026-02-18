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

export function expectSingleNpmPackIgnoreScriptsCall(params: {
  calls: Array<[unknown, unknown]>;
  expectedSpec: string;
}) {
  const packCalls = params.calls.filter(
    (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "pack",
  );
  expect(packCalls.length).toBe(1);
  const packCall = packCalls[0];
  if (!packCall) {
    throw new Error("expected npm pack call");
  }
  const [argv, options] = packCall;
  expect(argv).toEqual(["npm", "pack", params.expectedSpec, "--ignore-scripts"]);
  const commandOptions = typeof options === "number" ? undefined : options;
  expect(commandOptions).toMatchObject({ env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" } });
}
