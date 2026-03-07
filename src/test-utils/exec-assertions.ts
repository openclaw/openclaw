import path from "node:path";
import { expect } from "vitest";

function normalizeDarwinTmpPath(filePath: string): string {
  return process.platform === "darwin" && filePath.startsWith("/private/var/")
    ? filePath.slice("/private".length)
    : filePath;
}

export function expectSingleNpmInstallIgnoreScriptsCall(params: {
  calls: Array<[unknown, { cwd?: string } | undefined]>;
  expectedTargetDir: string;
}) {
  const npmCalls = params.calls.filter((call) => Array.isArray(call[0]) && call[0][0] === "npm");
  expect(npmCalls.length).toBe(1);
  const first = npmCalls[0];
  if (!first) {
    throw new Error("expected npm install call");
  }
  const [argv, opts] = first;
  expect(argv).toEqual([
    "npm",
    "install",
    "--omit=dev",
    "--omit=peer",
    "--silent",
    "--ignore-scripts",
  ]);
  expect(opts?.cwd).toBeTruthy();
  const cwd = normalizeDarwinTmpPath(String(opts?.cwd));
  const expectedTargetDir = normalizeDarwinTmpPath(params.expectedTargetDir);
  expect(path.dirname(cwd)).toBe(path.dirname(expectedTargetDir));
  expect(path.basename(cwd)).toMatch(/^\.openclaw-install-stage-/);
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
  expect(argv).toEqual(["npm", "pack", params.expectedSpec, "--ignore-scripts", "--json"]);
  const commandOptions = typeof options === "number" ? undefined : options;
  expect(commandOptions).toMatchObject({ env: { NPM_CONFIG_IGNORE_SCRIPTS: "true" } });
}
