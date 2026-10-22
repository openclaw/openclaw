import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDependencyPinViolations } from "../../scripts/check-dependency-pins.mts";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const itUnix = process.platform === "win32" ? it.skip : it;
const hangingGitTimeoutMs = 1_000;
const revision = "0123456789abcdef0123456789abcdef01234567";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  });
}

function violations(file: string, section: string, specs: [string, string][]) {
  return specs.map(([name, spec]) => ({ file, section, name, spec }));
}

function stubHangingGit(cwd: string, stalledSubcommand: "ls-files" | "show") {
  const binDir = path.join(cwd, "fake-git-bin");
  mkdirSync(binDir);
  const fixture = `#!/bin/sh
if [ "$1" = ${JSON.stringify(stalledSubcommand)} ]; then
  trap '' TERM
  exec sleep 60
elif [ "$1" = "ls-files" ]; then
  printf 'package.json\\000'
else
  exit 1
fi
`;
  writeFileSync(path.join(binDir, "git"), fixture, { mode: 0o755 });
  vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
}

function makeRepo(manifests: Record<string, unknown> = { "package.json": {} }, workspace?: string) {
  const dir = makeTempRepoRoot(tempDirs, "openclaw-dependency-pins-");
  git(dir, ["init", "-q", "--initial-branch=main"]);
  for (const [file, value] of Object.entries(manifests)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  }
  if (workspace) {
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), workspace);
  }
  git(dir, ["add", "."]);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs(tempDirs);
});

it("accepts exact dependency specs and intentionally ranged peer contracts", () => {
  const dir = makeRepo(
    {
      "package.json": {
        dependencies: {
          exact: "1.2.3",
          prerelease: "1.2.3-beta.1",
          alias: "npm:@scope/real-package@2.3.4",
          workspace: "workspace:*",
          linked: "link:../linked",
          local: "file:../local",
          gitPinned: `github:owner/repo#${revision}`,
          gitPinnedPath: `github:owner/repo#${revision}&path:packages/pkg`,
          tarballPinned: `https://codeload.github.com/owner/repo/tar.gz/${revision}`,
        },
        devDependencies: { devExact: "4.5.6" },
        optionalDependencies: { optionalExact: "7.8.9" },
        peerDependencies: { peerCanRange: "^1.0.0" },
      },
    },
    `overrides:
  exact: 1.2.3
  alias: "npm:@scope/real-package@2.3.4"
  parent>unused-adapter: "-"
packageExtensions:
  parent@1.0.0:
    dependencies:
      child: 3.2.1
`,
  );

  expect(collectDependencyPinViolations(dir)).toEqual([]);
});

it("rejects floating dependency specs in tracked package manifests", () => {
  const dir = makeRepo({
    "package.json": {
      dependencies: {
        caret: "^1.2.3",
        tilde: "~1.2.3",
        wildcard: "*",
        tag: "latest",
        broad: ">=1 <2",
        malformedSemver: "01.2.3",
        gitFloating: "github:owner/repo#main",
        fragmentlessGitPath: `git+https://github.com/owner/repo/commit/${revision}`,
        invalidRemoval: "-",
      },
    },
    "extensions/demo/package.json": {
      devDependencies: { devCaret: "^4.5.6" },
      optionalDependencies: { optionalTilde: "~7.8.9" },
      peerDependencies: { peerCanRange: "^10.0.0" },
    },
  });

  expect(collectDependencyPinViolations(dir)).toEqual([
    ...violations("extensions/demo/package.json", "devDependencies", [["devCaret", "^4.5.6"]]),
    ...violations("extensions/demo/package.json", "optionalDependencies", [
      ["optionalTilde", "~7.8.9"],
    ]),
    ...violations("package.json", "dependencies", [
      ["caret", "^1.2.3"],
      ["tilde", "~1.2.3"],
      ["wildcard", "*"],
      ["tag", "latest"],
      ["broad", ">=1 <2"],
      ["malformedSemver", "01.2.3"],
      ["gitFloating", "github:owner/repo#main"],
      ["fragmentlessGitPath", `git+https://github.com/owner/repo/commit/${revision}`],
      ["invalidRemoval", "-"],
    ]),
  ]);
});

it("reads tracked package manifests from the index when sparse checkout omits them", () => {
  const dir = makeRepo({
    "package.json": {},
    "qa/convex-credential-broker/package.json": { dependencies: { exact: "1.2.3" } },
  });
  rmSync(path.join(dir, "qa"), { recursive: true, force: true });

  expect(collectDependencyPinViolations(dir)).toEqual([]);
});

itUnix.each(["ls-files", "show"] as const)("terminates SIGTERM-resistant git %s", (command) => {
  const dir =
    command === "show"
      ? makeRepo()
      : makeTempRepoRoot(tempDirs, "openclaw-dependency-pins-timeout-");
  if (command === "show") {
    rmSync(path.join(dir, "package.json"));
  }
  stubHangingGit(dir, command);
  expect(() => collectDependencyPinViolations(dir, { gitTimeoutMs: hangingGitTimeoutMs })).toThrow(
    `dependency pin guard: git ${command === "show" ? "show :package.json" : "ls-files -z -- *package.json"} timed out after ${hangingGitTimeoutMs}ms.`,
  );
});

it("rejects floating workspace overrides and package extension dependencies", () => {
  const dir = makeRepo(
    undefined,
    `overrides:
  exact: 1.2.3
  floating: ^2.0.0
packageExtensions:
  parent@1.0.0:
    dependencies:
      exact-child: 3.2.1
      floating-child: ~4.0.0
`,
  );

  expect(collectDependencyPinViolations(dir)).toEqual([
    ...violations("pnpm-workspace.yaml", "overrides", [["floating", "^2.0.0"]]),
    ...violations("pnpm-workspace.yaml", "packageExtensions.parent@1.0.0.dependencies", [
      ["floating-child", "~4.0.0"],
    ]),
  ]);
});
