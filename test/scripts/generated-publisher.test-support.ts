import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";
import { parse } from "yaml";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
const PUBLISH_GENERATED_PR_ACTION = ".github/actions/publish-generated-pr/action.yml";
const publisherTemplateDirs = useAutoCleanupTempDirTracker(afterAll);
let generatedPublisherTemplate: { root: string; initialMain: string } | undefined;
function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  chmodSync(filePath, 0o755);
}
function writeFixture(root: string, name: string, content: string): void {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}
function copyGeneratedPublisherFixture(root: string, workspaceName: string) {
  if (!generatedPublisherTemplate) {
    const templateRoot = publisherTemplateDirs.make("openclaw-generated-pr-template-");
    const origin = path.join(templateRoot, "origin.git");
    const worktree = path.join(templateRoot, "worktree");
    mkdirSync(worktree);
    runGit(templateRoot, ["init", "--bare", origin]);
    runGit(templateRoot, ["init", "--initial-branch=main", worktree]);
    runGit(worktree, ["config", "user.name", "Test Publisher"]);
    runGit(worktree, ["config", "user.email", "publisher@example.com"]);
    writeFixture(worktree, "generated/a.txt", "old-a\n");
    writeFixture(worktree, "generated/b.txt", "old-b\n");
    writeFixture(worktree, "source/input.txt", "old-input\n");
    runGit(worktree, ["add", "generated", "source"]);
    runGit(worktree, ["commit", "-m", "base"]);
    runGit(worktree, ["remote", "add", "origin", "../origin.git"]);
    runGit(worktree, ["push", "-u", "origin", "main"]);
    runGit(templateRoot, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const initialMain = runGit(worktree, ["rev-parse", "HEAD"]);
    generatedPublisherTemplate = { root: templateRoot, initialMain };
  }
  // Immutable seed and relative origin isolate each copy's initial commit, refs, hooks and config.
  for (const name of ["origin.git", "worktree"]) {
    cpSync(
      path.join(generatedPublisherTemplate.root, name),
      path.join(root, name === "worktree" ? workspaceName : name),
      { recursive: true, mode: fsConstants.COPYFILE_FICLONE },
    );
  }
  return generatedPublisherTemplate.initialMain;
}

export type GeneratedPublisherOptions = {
  headBranch?: string;
  disarmRace?: boolean;
  updateSourceBeforeAutoMerge?: boolean;
  race?: "delete" | "advance" | "recreate";
  reconciliation?: "missing" | "merged";
  autoMerge?: boolean;
  existingAutoMergeMethod?: "MERGE" | "REBASE" | "SQUASH";
  existingPr?: boolean;
  expectFailure?: boolean;
  failGeneratedPush?: boolean;
  generatedFiles?: Record<string, string>;
  invalidationPaths?: string;
  malformedAutoMergeRecord?: boolean;
  mergeGeneratedPush?: boolean;
  noGeneratedChange?: boolean;
  overlapPolicy?: string;
  stalePrHeadOnce?: boolean;
  stalePrViewHeadOnce?: boolean;
  updateSource?: boolean | string;
};
export function prepareGeneratedPublisherFixture(
  root: string,
  baseChangePath: "a" | "b" | null,
  options: GeneratedPublisherOptions = {},
  workspaceName = "worktree",
) {
  const headBranch = options.headBranch ?? "automation/locale";
  const origin = path.join(root, "origin.git");
  const updater = path.join(root, "updater");
  const worktree = path.join(root, workspaceName);
  const fakeBin = path.join(root, "publisher-bin");
  const runnerTemp = path.join(root, "runner-temp");
  const prState = path.join(root, "pr-open");
  const mergeCalls = path.join(root, "merge-calls");
  const stalePrHeadOnce = path.join(root, "stale-pr-head-once");
  const stalePrViewHeadOnce = path.join(root, "stale-pr-view-head-once");
  const summary = path.join(root, "summary.md");

  const initialMain = copyGeneratedPublisherFixture(root, workspaceName);
  let initialBranch = "";
  mkdirSync(fakeBin);
  mkdirSync(runnerTemp, { recursive: true });
  writeFileSync(summary, "", "utf8");
  if (options.stalePrHeadOnce) {
    writeFileSync(stalePrHeadOnce, "", "utf8");
  }
  if (options.stalePrViewHeadOnce) {
    writeFileSync(stalePrViewHeadOnce, "", "utf8");
  }
  if (options.existingPr) {
    runGit(worktree, ["switch", "-c", headBranch]);
    writeFixture(worktree, "generated/a.txt", "stale-pr-a\n");
    runGit(worktree, ["add", "generated"]);
    runGit(worktree, ["commit", "-m", "stale generated pull request"]);
    runGit(worktree, ["push", "-u", "origin", headBranch]);
    initialBranch = runGit(worktree, ["rev-parse", "HEAD"]);
    writeFileSync(prState, "", "utf8");
    runGit(worktree, ["switch", "main"]);
  }
  if (baseChangePath !== null || options.updateSource || options.updateSourceBeforeAutoMerge) {
    runGit(root, ["clone", "--branch", "main", origin, updater]);
    runGit(updater, ["config", "user.name", "Base Updater"]);
    runGit(updater, ["config", "user.email", "updater@example.com"]);
    if (baseChangePath !== null) {
      writeFixture(updater, `generated/${baseChangePath}.txt`, `newer-${baseChangePath}\n`);
    }
    if (options.updateSource) {
      const sourcePath =
        typeof options.updateSource === "string" ? options.updateSource : "source/input.txt";
      writeFixture(updater, sourcePath, "newer-input\n");
    }
    if (!options.updateSourceBeforeAutoMerge) {
      runGit(updater, ["add", "--all"]);
      runGit(updater, ["commit", "-m", "update base"]);
      runGit(updater, ["push", "origin", "main"]);
    }
  }
  if (!options.noGeneratedChange) {
    writeFixture(worktree, "generated/a.txt", "desired-a\n");
  }
  for (const [name, contents] of Object.entries(options.generatedFiles ?? {})) {
    writeFixture(worktree, name, contents);
  }
  if (options.failGeneratedPush) {
    writeExecutable(path.join(origin, "hooks", "pre-receive"), [
      "#!/bin/sh",
      'rm -f "$0"',
      "exit 1",
    ]);
  }
  if (options.mergeGeneratedPush) {
    writeExecutable(path.join(origin, "hooks", "post-receive"), [
      "#!/bin/sh",
      "while read -r old_head new_head ref; do",
      '  if [ "$ref" = "refs/heads/${FAKE_HEAD_BRANCH}" ]; then',
      '    git update-ref refs/heads/main "$new_head"',
      '    git update-ref -d refs/heads/${FAKE_HEAD_BRANCH} "$new_head"',
      "  fi",
      "done",
    ]);
  }

  writeExecutable(path.join(fakeBin, "sleep"), ["#!/bin/sh", "exit 0"]);
  writeExecutable(path.join(fakeBin, "gh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'printf "%s\\n" "$*" >> "$FAKE_GH_CALLS"',
    "read_head() {",
    '  if [[ -f "$1" ]]; then',
    '    head="0000000000000000000000000000000000000000"',
    '    rm -f "$1"',
    "  else",
    '    head="$("${FAKE_REAL_GIT:-git}" --git-dir="$FAKE_ORIGIN" rev-parse refs/heads/${FAKE_HEAD_BRANCH})"',
    "  fi",
    "}",
    'if [[ "$FAKE_UPDATE_BEFORE_AUTO_MERGE" == "true" && ( "${1-}:${2-}" == "pr:create" || "${1-}:${2-}" == "pr:edit" ) ]]; then',
    '  printf "newer-input\\n" > "$FAKE_UPDATER/source/input.txt"',
    '  git -C "$FAKE_UPDATER" add source/input.txt',
    '  git -C "$FAKE_UPDATER" -c commit.gpgsign=false commit -m "advance generator inputs" >&2',
    '  git -C "$FAKE_UPDATER" push origin main >&2',
    "fi",
    'case "${1-}:${2-}" in',
    "  auth:setup-git) exit 0 ;;",
    "  api:*)",
    '    if [[ -f "$FAKE_PR_STATE" ]]; then',
    '      read_head "$FAKE_STALE_HEAD_ONCE"',
    '      printf "https://github.com/openclaw/openclaw/pull/1\\t%s\\n" "$head"',
    "    fi",
    "    ;;",
    "  pr:create)",
    '    if [[ "$FAKE_RECONCILIATION" == "" ]]; then : > "$FAKE_PR_STATE"; fi',
    '    if [[ "$FAKE_RECONCILIATION" == "merged" ]]; then "$FAKE_REAL_GIT" --git-dir="$FAKE_ORIGIN" update-ref refs/heads/main "$("$FAKE_REAL_GIT" --git-dir="$FAKE_ORIGIN" rev-parse refs/heads/${FAKE_HEAD_BRANCH})"; fi',
    '    printf "%s\\n" "https://github.com/openclaw/openclaw/pull/1"',
    "    ;;",
    "  pr:edit) exit 0 ;;",
    "  pr:view)",
    '    if [[ -f "$FAKE_MERGE_CALLS.disabled" ]]; then FAKE_AUTO_MERGE_METHOD=""; fi',
    '    [[ -n "${GH_TOKEN:-}" ]]',
    '    [[ -f "$FAKE_PR_STATE" ]]',
    '    read_head "$FAKE_STALE_PR_VIEW_HEAD_ONCE"',
    '    if [[ "$FAKE_MALFORMED_AUTO_MERGE_RECORD" == "true" ]]; then printf "%s\\n" "$head"; else printf "%s\\t%s\\n" "$head" "$FAKE_AUTO_MERGE_METHOD"; fi',
    '    if [[ -n "$FAKE_RACE" && ! -f "$FAKE_PR_STATE.raced" ]]; then',
    '      : > "$FAKE_PR_STATE.raced"',
    '      if [[ "$FAKE_RACE" == "advance" ]]; then',
    '        "$FAKE_REAL_GIT" --git-dir="$FAKE_ORIGIN" update-ref refs/heads/${FAKE_HEAD_BRANCH} "$FAKE_INITIAL_MAIN"',
    "      else",
    '        "$FAKE_REAL_GIT" --git-dir="$FAKE_ORIGIN" update-ref -d refs/heads/${FAKE_HEAD_BRANCH} "$head"',
    "      fi",
    "    fi",
    "    ;;",
    "  pr:merge)",
    '    [[ "$GH_TOKEN" == "test-token" ]]',
    '    printf "%s\\n" "$*" >> "$FAKE_MERGE_CALLS"',
    '    if [[ " $* " == *" --disable-auto "* ]]; then',
    '      : > "$FAKE_MERGE_CALLS.disabled"',
    '      if [[ "$FAKE_DISARM_RACE" == "true" ]]; then "${FAKE_REAL_GIT:-git}" --git-dir="$FAKE_ORIGIN" update-ref refs/heads/${FAKE_HEAD_BRANCH} "$FAKE_INITIAL_MAIN"; fi',
    "    fi",
    "    ;;",
    '  *) printf "unexpected gh call: %s\\n" "$*" >&2; exit 2 ;;',
    "esac",
  ]);

  return {
    worktree,
    fakeBin,
    initialBranch,
    env: {
      FAKE_UPDATE_BEFORE_AUTO_MERGE: String(options.updateSourceBeforeAutoMerge ?? false),
      FAKE_UPDATER: updater,
      FAKE_DISARM_RACE: String(options.disarmRace ?? false),
      FAKE_RACE: options.race ?? "",
      FAKE_INITIAL_MAIN: initialMain,
      FAKE_RECONCILIATION: options.reconciliation ?? "",
      BASE_BRANCH: "main",
      COMMIT_MESSAGE: "chore(test): refresh generated output",
      AUTO_MERGE: String(options.autoMerge ?? false),
      FAKE_AUTO_MERGE_METHOD: options.existingAutoMergeMethod ?? "",
      FAKE_MALFORMED_AUTO_MERGE_RECORD: String(options.malformedAutoMergeRecord ?? false),
      FAKE_ORIGIN: origin,
      FAKE_HEAD_BRANCH: headBranch,
      FAKE_GH_CALLS: path.join(root, "gh-calls"),
      FAKE_MERGE_CALLS: mergeCalls,
      FAKE_PR_STATE: prState,
      FAKE_STALE_HEAD_ONCE: stalePrHeadOnce,
      FAKE_STALE_PR_VIEW_HEAD_ONCE: stalePrViewHeadOnce,
      GENERATED_PATHS: "generated",
      INVALIDATION_PATHS: options.invalidationPaths ?? "source",
      OVERLAP_POLICY: options.overlapPolicy ?? "defer",
      CONTENTS_TOKEN: "contents-token",
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REPOSITORY_OWNER: "openclaw",
      GITHUB_STEP_SUMMARY: summary,
      HEAD_BRANCH: headBranch,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      PR_BODY: "Generated test body",
      PR_TITLE: "chore(test): refresh generated output",
      RUNNER_TEMP: runnerTemp,
    },
    inspect(publishOutput: string, checkAuth = true) {
      if (checkAuth) {
        const authHeader = spawnSync(
          "git",
          ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
          { cwd: worktree, encoding: "utf8" },
        );
        if (authHeader.status !== 1 || authHeader.stdout.trim() !== "") {
          throw new Error("generated publisher left its Git authorization header configured");
        }
      }

      const branchRef = "refs/heads/" + headBranch;
      const originGit = (...args: string[]) => runGit(root, ["--git-dir", origin, ...args]);
      const branch = spawnSync(
        "git",
        ["--git-dir", origin, "show-ref", "--verify", "--hash", branchRef],
        { encoding: "utf8" },
      );
      const branchExists = branch.status === 0;
      const branchHead = branchExists ? branch.stdout.trim() : "";
      const generated = (file: string) =>
        branchExists ? originGit("show", `${branchRef}:generated/${file}.txt`) : "";
      return {
        branchExists,
        branchHead,
        localHead: runGit(worktree, ["rev-parse", "HEAD"]),
        generatedFiles: Object.fromEntries(
          Object.keys(options.generatedFiles ?? {}).map((name) => [
            name,
            branchExists
              ? execFileSync("git", ["--git-dir", origin, "show", `${branchRef}:${name}`], {
                  encoding: "utf8",
                })
              : "",
          ]),
        ),
        initialBranch,
        generatedA: generated("a"),
        generatedB: generated("b"),
        mainGeneratedA: originGit("show", "refs/heads/main:generated/a.txt"),
        mainHead: originGit("rev-parse", "refs/heads/main"),
        mergeCalls: existsSync(mergeCalls) ? readFileSync(mergeCalls, "utf8") : "",
        publishOutput,
        summary: readFileSync(summary, "utf8"),
      };
    },
  };
}
export function runGeneratedPublisherScenario(
  baseChangePath: "a" | "b" | null,
  options: GeneratedPublisherOptions = {},
) {
  const tempDirs = createTempDirTracker();
  const root = tempDirs.make("openclaw-generated-pr-");
  try {
    const fixture = prepareGeneratedPublisherFixture(root, baseChangePath, options);
    const action = parse(readFileSync(PUBLISH_GENERATED_PR_ACTION, "utf8"));
    const run = action.runs.steps.find(
      (step: { name?: string }) => step.name === "Publish generated pull request",
    ).run;
    writeExecutable(path.join(fixture.fakeBin, "timeout"), [
      "#!/bin/bash",
      'while [[ "$#" -gt 0 ]]; do case "$1" in --signal=*|--kill-after=*) shift ;; [0-9]*s) shift; break ;; *) break ;; esac; done',
      'exec "$@"',
    ]);
    const publish = spawnSync("bash", ["-c", run], {
      cwd: fixture.worktree,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fixture.env,
        CI_GIT_OWNER: path.resolve(".github/actions/git-owner/owner.py"),
        PUBLISH_ACTION_PATH: path.resolve(".github/actions/publish-generated-pr"),
      },
    });
    const publishOutput = `${publish.stdout}${publish.stderr}`;
    if (options.expectFailure ? publish.status === 0 : publish.status !== 0) {
      throw new Error(
        `generated publisher exited ${String(publish.status)} (expected ${options.expectFailure ? "failure" : "success"}):\n${publishOutput}`,
      );
    }
    return fixture.inspect(publishOutput);
  } finally {
    tempDirs.cleanup();
  }
}
