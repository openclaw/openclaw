import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import {
  configureMerge,
  expectAncestors,
  expectCapturedFiles,
  expectExit,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";
import {
  copyPrWrapperSources,
  createIndependentPrFixtureEnv,
  linkPrWrapperDependencies,
} from "./pr-wrapper.test-support.js";

const { fixture, reuseCompletedSetup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();
const bindingRef = "refs/openclaw/pr-workflow-bindings/123";
const wrapper = readFileSync("scripts/pr", "utf8");
const gitOwner = wrapper.slice(
  wrapper.indexOf("pr_batch_wrapper_git() {"),
  wrapper.indexOf("\nEOF_WRAPPER_GIT\n}") + "\nEOF_WRAPPER_GIT\n}".length,
);

function sourceCommit(
  f: ReturnType<typeof fixture>,
  parent: string,
  directory: string,
  current: boolean,
) {
  copyPrWrapperSources(directory);
  writeFileSync(join(directory, "owner.txt"), f.git(["show", `${parent}:owner.txt`]) + "\n");
  if (!current) {
    // Pre-admission writers preserve unknown JSON and their predecessor, but
    // retain only the historical schema's direct parents.
    const outcome = join(directory, "scripts/pr-lib/merge-outcome.sh");
    writeFileSync(
      outcome,
      readFileSync(outcome, "utf8").replace(
        ",.workflowAdmission.binding,.workflowAdmission.from,.workflowAdmission.to",
        "",
      ),
    );
  }
  if (current) {
    const path = join(directory, "scripts/pr-lib/review.sh");
    writeFileSync(path, readFileSync(path, "utf8") + "\n# Current canonical workflow fixture.\n");
  }
  const index = join(f.root, "source.index");
  const run = (args: string[], input?: string) => {
    const result = spawnSync("git", ["-C", f.repo, ...args], {
      env: { ...createIndependentPrFixtureEnv(), GIT_INDEX_FILE: index },
      input,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  run(["read-tree", parent]);
  const paths = listDirectoryTreeStrictSync(directory)
    .map((walkEntry) => walkEntry.dirent)
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
  const blobs = run(
    ["hash-object", "-w", "--stdin-paths"],
    paths.map((path) => JSON.stringify(join(directory, path))).join("\n") + "\n",
  ).split("\n");
  run(
    ["update-index", "--index-info"],
    paths.map((path, position) => `100644 ${blobs[position]}\t${path}\n`).join(""),
  );
  linkPrWrapperDependencies(directory);
  return f.commit(
    run(["write-tree"]),
    [parent],
    current ? "Current workflow\n" : "Retained workflow\n",
  );
}

const cancelled = reuseCompletedSetup((confirmed = true) => {
  const f = fixture();
  const retainedDirectory = join(f.root, "retained-source");
  const source = sourceCommit(f, f.base, retainedDirectory, false);
  f.git(["push", "-q", "origin", `${source}:refs/heads/main`]);
  f.workflowSource(source, retainedDirectory);
  f.bindWorkflow();
  configureMerge(f, { mode: "pending", pr: { mergeStateStatus: "BLOCKED" } });
  expectExit(f.run(true), 0);
  const original = f.git(["rev-parse", outcomeRef]);
  if (confirmed) {
    expectExit(f.cancel(original), 0);
  }
  const outcome = f.git(["rev-parse", outcomeRef]);
  const binding = f.git(["rev-parse", bindingRef]);
  const replacement = f.replacePreparedHead();
  const main = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
  const directory = join(f.root, "selected-source");
  const current = sourceCommit(f, main, directory, true);
  f.git(["push", "-q", "origin", `${current}:refs/heads/main`]);
  f.git(["fetch", "-q", "origin", "main"]);
  f.workflowSource(source, directory);
  configureMerge(f, { mode: "success", pr: { mergeStateStatus: "CLEAN" } });
  // Keep Git transport private while qualifying the configured product source.
  f.git([
    "config",
    "--add",
    `url.file://${f.remote}.insteadOf`,
    "https://github.com/openclaw/openclaw",
  ]);
  f.git(["remote", "set-url", "origin", "https://github.com/openclaw/openclaw"]);
  return { f, outcome, binding, replacement, original, source, directory };
});

function selection(
  setup: ReturnType<typeof cancelled>,
  outcome = setup.outcome,
  head = setup.replacement,
) {
  const { f } = setup;
  const shell = join(f.root, "select.sh");
  writeFileSync(
    shell,
    `${gitOwner}\npr_batch_wrapper_git workflow-recovery-select "$1" 123 "$2" "$3"\n`,
  );
  return spawnSync("bash", [shell, f.repo, outcome, head], {
    env: { ...createIndependentPrFixtureEnv(), GIT_EXEC: "git" },
    encoding: "utf8",
  });
}

const { preExistingCandidate, artifactBuildCandidate } = createPriorCiCandidateFactory(fixture);
const firstAdmission = reuseCompletedSetup(() => {
  const f = artifactBuildCandidate();
  const retainedDirectory = join(f.root, "retained-source");
  const source = sourceCommit(f, f.base, retainedDirectory, false);
  const directory = join(f.root, "selected-source");
  const current = sourceCommit(f, source, directory, true);
  f.git(["push", "-q", "origin", `${current}:refs/heads/main`]);
  f.git(["fetch", "-q", "origin", "main"]);
  f.workflowSource(source, directory);
  f.bindWorkflow();
  f.useScripts(join(directory, "scripts"));
  f.git([
    "config",
    "--add",
    `url.file://${f.remote}.insteadOf`,
    "https://github.com/openclaw/openclaw",
  ]);
  f.git(["remote", "set-url", "origin", "https://github.com/openclaw/openclaw"]);
  configureMerge(f, { comment: "lost" });
  return { f, source, current, retainedDirectory, directory };
});

function admitCurrent(setup: ReturnType<typeof firstAdmission>) {
  const { f } = setup;
  return f.run(
    false,
    f.repo,
    "squash",
    "",
    "",
    "",
    "",
    "",
    false,
    "",
    false,
    f.path,
    true,
    "",
    "",
    true,
  );
}

function historicalSuccessor(f: ReturnType<typeof fixture>, source: string) {
  // Storage fixture for the later merge owner: the prepare command's authority
  // and interruption behavior are exercised by pr-workflow-successor.test.ts.
  const record = {
    version: 1,
    repository: realpathSync(f.remote),
    owner: realpathSync(join(f.repo, ".git")),
    pr: "123",
    source: f.base,
  };
  const commit = (value: object, parents: string[], extra = "") => {
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(value));
    const tree = f.git(["mktree"], `100644 blob ${blob}\tbinding.json\n${extra}`);
    return f.commit(tree, parents, "Retained workflow fixture\n");
  };
  const previous = commit(record, [f.base]);
  const review = f.git(["hash-object", "-w", "--stdin"], "retained review\n");
  const snapshot = f.git(
    ["hash-object", "-w", "--stdin"],
    `.local/correction-review.json ${review}`,
  );
  const binding = commit(
    {
      ...record,
      version: 2,
      source,
      predecessor: previous,
      continuation: {
        head: f.head,
        hostedHead: f.head,
        tree: f.git(["rev-parse", `${f.head}^{tree}`]),
        review,
        snapshot,
      },
    },
    [previous, source, f.head],
    `100644 blob ${snapshot}\treview-snapshot\n`,
  );
  f.git(["update-ref", bindingRef, binding]);
  return binding;
}

describePosix("current-main first admission with a retained workflow", () => {
  it("reconciles admission provenance that references a historical successor binding", () => {
    const setup = firstAdmission();
    const { f, source, current } = setup;
    const binding = historicalSuccessor(f, source);
    expectExit(admitCurrent(setup), 1);
    expect(f.record()).toMatchObject({ workflowAdmission: { binding, from: source, to: current } });
    f.recover();
    expectExit(f.run(), 0);
    expectAncestors(f, [binding, source, current], outcomeRef);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
  });
  it("native entrypoint accepts only the explicit first-admission shape and fences an existing outcome", () => {
    const { f, source } = firstAdmission();
    const bind = join(f.root, "bind.sh");
    writeFileSync(bind, `${gitOwner}\npr_batch_wrapper_git workflow-admit "$1" 123 "$2" ""\n`);
    const env = { ...createIndependentPrFixtureEnv(), GIT_EXEC: "git", GIT_ALLOW_PROTOCOL: "file" };
    const bound = spawnSync("bash", [bind, f.repo, source], { env, encoding: "utf8" });
    expect(bound.status, bound.stderr).toBe(0);
    const binding = f.git(["rev-parse", bindingRef]);
    const rejected = f.git(["hash-object", "-w", "--stdin"], "rejected");
    f.git(["update-ref", outcomeRef, rejected]);
    mkdirSync(join(f.repo, "scripts"), { recursive: true });
    writeFileSync(join(f.repo, "scripts/pr"), wrapper);
    const args = [
      "merge-run",
      "123",
      "--current-workflow",
      "--admin-evidence",
      f.path,
      "--confirmed-operator-admin",
    ];
    const invoke = (argv: string[]) =>
      spawnSync("bash", [join(f.repo, "scripts/pr"), ...argv], {
        cwd: f.repo,
        env,
        encoding: "utf8",
      });
    const result = invoke(args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("first admission requires no retained outcome");
    for (const invalid of [
      args.slice(0, -1),
      [...args, "--auto-merge"],
      [...args, "--current-workflow"],
      [...args, "--replacement-head", f.head],
    ]) {
      const refused = invoke(invalid);
      expect(refused.status, refused.stderr).toBe(2);
      expect(refused.stderr).toContain("--current-workflow requires");
    }
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expect(f.git(["rev-parse", outcomeRef])).toBe(rejected);
    expect(f.state().mutations).toBe(0);
  });

  it("retains the original binding through lost acknowledgment, reconciliation, and completion", () => {
    const setup = firstAdmission();
    const { f, source, current, retainedDirectory, directory } = setup;
    expectExit(admitCurrent(setup), 1);
    const binding = f.git(["rev-parse", bindingRef]);
    const admission = { binding, from: source, to: current };
    expect(f.record()).toMatchObject({ phase: "commenting", workflowAdmission: admission });
    expect(f.record()).not.toHaveProperty("workflowRecovery");
    expect(f.record()).not.toHaveProperty("recovery");
    expectAncestors(f, [binding, source, current], outcomeRef);
    f.recover();
    f.useScripts(join(retainedDirectory, "scripts"));
    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "commented", workflowAdmission: admission });
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["push", "-q", "origin", ":refs/heads/topic"]);
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])), 0);
    expect(f.record()).toMatchObject({ phase: "complete", workflowAdmission: admission });
    f.useScripts(join(directory, "scripts"));
    expectExit(f.run(), 0);
    expectAncestors(f, [binding, source, current], outcomeRef);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
  });

  it.each(["outcome", "symbolic outcome", "capture", "head", "source", "binding"])(
    "refuses first-admission %s drift before dispatch",
    (fault) => {
      const setup = firstAdmission();
      const { f, source, current } = setup;
      if (fault === "capture") {
        writeFileSync(join(f.worktree, ".local/merge-output.log"), "");
      } else if (fault === "outcome") {
        f.git(["update-ref", outcomeRef, f.git(["hash-object", "-w", "--stdin"], "rejected")]);
      } else if (fault === "symbolic outcome") {
        f.git(["symbolic-ref", outcomeRef, "refs/heads/main"]);
      } else if (fault === "head") {
        configureMerge(f, { pr: { headRefOid: f.base } });
      } else {
        const hook = join(f.root, "after-hold.sh");
        const command =
          fault === "source"
            ? `git --git-dir='${f.remote}' update-ref refs/heads/main '${source}' '${current}'`
            : `git -C '${f.repo}' update-ref '${bindingRef}' '${source}'`;
        writeFileSync(hook, command + "\n");
        f.workflowAfterHold(hook);
      }
      const result = admitCurrent(setup);
      expectExit(result, 1);
      expect(result.output).toMatch(/retained outcome|merge output|head|workflow|binding/i);
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    },
  );
});

const rejectedAdmin = reuseCompletedSetup(() => {
  const f = preExistingCandidate();
  const retainedDirectory = join(f.root, "retained-source");
  const source = sourceCommit(f, f.base, retainedDirectory, false);
  f.git(["push", "-q", "origin", `${source}:refs/heads/main`]);
  f.workflowSource(source, retainedDirectory);
  f.bindWorkflow();
  const refusal = readFileSync("test/fixtures/pr-admin-base-modified-405.txt", "utf8");
  configureMerge(f, { restMergeRefusal: refusal });
  expectExit(f.adminPriorCi(f.path), 1);
  const outcome = f.git(["rev-parse", outcomeRef]);
  expect(f.record()).toMatchObject({ route: "admin", accepted: false, phase: "intent" });
  f.recover();
  const binding = f.git(["rev-parse", bindingRef]);
  const directory = join(f.root, "selected-source");
  const current = sourceCommit(f, source, directory, true);
  f.git(["push", "-q", "origin", `${current}:refs/heads/main`]);
  f.git(["fetch", "-q", "origin", "main"]);
  f.workflowSource(source, directory);
  f.useScripts(join(directory, "scripts"));
  f.git([
    "config",
    "--add",
    `url.file://${f.remote}.insteadOf`,
    "https://github.com/openclaw/openclaw",
  ]);
  f.git(["remote", "set-url", "origin", "https://github.com/openclaw/openclaw"]);
  configureMerge(f, { restMergeRefusal: "", comment: "lost" });
  return { f, outcome, binding, source, current };
});

function recoverAdmin(setup: ReturnType<typeof rejectedAdmin>) {
  const { f, outcome } = setup;
  return f.run(
    false,
    f.repo,
    "squash",
    outcome,
    "",
    "",
    "",
    "",
    false,
    "",
    false,
    f.path,
    true,
    "",
    "",
    true,
  );
}

describePosix("current-main recovery of a retained workflow", () => {
  it("reconciles recovery provenance that references a historical successor binding", () => {
    const setup = rejectedAdmin();
    const { f, source, current } = setup;
    const binding = historicalSuccessor(f, source);
    expectExit(recoverAdmin(setup), 1);
    expect(f.record()).toMatchObject({ workflowRecovery: { binding, from: source, to: current } });
    f.recover();
    expectExit(f.run(), 0);
    expectAncestors(f, [binding, source, current], outcomeRef);
    expect(f.state()).toMatchObject({ mutations: 2, posts: 1 });
  });

  it("native entrypoint admits only the explicit admin shape and refuses a stale outcome before execution", () => {
    const { f, outcome, binding } = rejectedAdmin();
    mkdirSync(join(f.repo, "scripts"), { recursive: true });
    writeFileSync(join(f.repo, "scripts/pr"), wrapper);
    const args = [
      "merge-recover",
      "123",
      "a".repeat(40),
      "--confirmed-operator-recovery",
      "--admin-evidence",
      f.path,
      "--confirmed-operator-admin",
      "--current-workflow",
    ];
    const invoke = (argv: string[]) =>
      spawnSync("bash", [join(f.repo, "scripts/pr"), ...argv], {
        cwd: f.repo,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ALLOW_PROTOCOL: "file",
        },
        encoding: "utf8",
      });
    const selected = invoke(args);
    expect(selected.status, selected.stderr).toBe(1);
    expect(selected.stderr).toContain("Current workflow recovery outcome changed");
    const replacement = invoke([
      ...args.slice(0, 2),
      outcome,
      ...args.slice(3),
      "--replacement-head",
      f.head,
    ]);
    expect(replacement.status).toBe(1);
    expect(replacement.stderr).toContain(
      "Current workflow recovery requires a confirmed cancelled nonqueue auto outcome",
    );
    const unconfirmed = invoke(args.filter((arg) => arg !== "--confirmed-operator-admin"));
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain("--current-workflow requires confirmed merge-recover");
    expect(f.git(["rev-parse", outcomeRef])).toBe(outcome);
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
  });

  it("explicitly selects current workflow for qualified same-head admin rejection recovery", () => {
    const setup = rejectedAdmin();
    const { f, outcome, binding, source, current } = setup;
    const captures = f.captures();
    const recovered = recoverAdmin(setup);
    expectExit(recovered, 1);
    expect(f.record(), recovered.output).toMatchObject({
      phase: "commenting",
      head: f.head,
      accepted: true,
      workflowRecovery: { binding, from: source, to: current },
      recovery: { outcome, providerRejection: { kind: "github-base-modified-405" } },
    });
    expect(f.record().recovery).not.toHaveProperty("replacementHead");
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expectAncestors(f, [outcome, binding, source, current], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);
  });

  it.each(["capture", "head", "admin", "security"])(
    "current workflow cannot bypass same-head admin recovery %s validation",
    (fault) => {
      const setup = rejectedAdmin();
      const { f, outcome, binding } = setup;
      if (fault === "capture") {
        writeFileSync(
          join(f.worktree, ".local", `merge-output.${f.record().attempt}.log`),
          "HTTP 405\n",
        );
      } else {
        const state = f.state();
        if (fault === "head") {
          state.pr.headRefOid = f.base;
        }
        if (fault === "admin") {
          state.priorCi.membership = "member";
        }
        if (fault === "security") {
          state.priorCi.security.fault = "failed-guard";
        }
        f.save(state);
      }
      const result = recoverAdmin(setup);
      expectExit(result, 1);
      expect(result.output).not.toMatch(/current workflow recovery requires/i);
      expect(result.output).toMatch(
        fault === "capture"
          ? /complete exact GitHub base-modified HTTP 405 rejection/
          : fault === "head"
            ? /head|prepared/i
            : fault === "admin"
              ? /writer must be an active organization admin/
              : /security|guard/i,
      );
      expect(f.git(["rev-parse", outcomeRef])).toBe(outcome);
      expect(f.git(["rev-parse", bindingRef])).toBe(binding);
      expect(f.state().pr.mergeCommit).toBeNull();
    },
  );

  it("retains the binding and cancelled history through real recovery and ordinary reconciliation", () => {
    const setup = cancelled();
    const { f, outcome, binding, replacement, original, source, directory } = setup;
    const captures = f.captures();
    const main = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    const selected = selection(setup);
    expectExit({ ...selected, output: selected.stdout + selected.stderr }, 0);
    expect(selected.stdout.trim()).toBe(`${binding}\t${main}`);
    // Lost comment acknowledgement leaves ordinary reconciliation meaningful.
    configureMerge(f, { comment: "lost" });
    f.useScripts(join(directory, "scripts"));
    const recovery = f.run(
      false,
      f.repo,
      "squash",
      outcome,
      replacement,
      "",
      "",
      "",
      false,
      "",
      false,
      "",
      false,
      "",
      "",
      true,
    );
    expectExit(recovery, 1);
    const successor = f.git(["rev-parse", outcomeRef]);
    expect(f.record(), recovery.output).toMatchObject({
      phase: "commenting",
      head: replacement,
      recovery: { outcome, replacementHead: replacement },
      workflowRecovery: { binding, from: source, to: main },
    });
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expectAncestors(f, [original, outcome, binding, source, main], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);
    f.recover();
    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "commented" });
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expect(f.git(["merge-base", "--is-ancestor", successor, outcomeRef])).toBe("");
  });

  it.each(["source", "outcome", "head"])(
    "refuses late %s drift without another dispatch",
    (fault) => {
      const { f, outcome, binding, replacement, original } = cancelled();
      const hook = join(f.root, "after-hold.sh");
      let commands: string;
      if (fault === "source") {
        const main = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
        const changed = sourceCommit(f, main, join(f.root, "changed-source"), false);
        f.git(["push", "-q", "origin", `${changed}:refs/heads/next-main`]);
        commands = `git --git-dir='${f.remote}' update-ref refs/heads/main '${changed}'\n`;
      } else if (fault === "outcome") {
        commands = `git -C '${f.repo}' update-ref '${outcomeRef}' '${original}' '${outcome}'\n`;
      } else {
        const script = join(f.root, "change-provider.cjs");
        writeFileSync(
          script,
          `const fs=require('node:fs'); const p=${JSON.stringify(join(f.root, "server.json"))}; const s=JSON.parse(fs.readFileSync(p)); s.pr.headRefOid=${JSON.stringify(f.base)}; fs.writeFileSync(p,JSON.stringify(s));\n`,
        );
        commands = `node '${script}'\n`;
      }
      writeFileSync(hook, commands);
      f.workflowAfterHold(hook);
      const result = f.run(
        false,
        f.repo,
        "squash",
        outcome,
        replacement,
        "",
        "",
        "",
        false,
        "",
        false,
        "",
        false,
        "",
        "",
        true,
      );
      expectExit(result, 1);
      expect(result.output).toMatch(
        fault === "source"
          ? /Current main workflow changed/
          : fault === "outcome"
            ? /outcome changed/
            : /head|prepared/i,
      );
      expect(f.git(["rev-parse", bindingRef])).toBe(binding);
      expect(f.git(["rev-parse", outcomeRef])).toBe(fault === "outcome" ? original : outcome);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it.each([
    "stale outcome",
    "unselected head",
    "symbolic main",
    "foreign origin",
    "unconfirmed cancellation",
  ])("refuses %s before source admission", (fault) => {
    const setup = cancelled(fault !== "unconfirmed cancellation");
    const { f, outcome, binding } = setup;
    let selectedOutcome = outcome;
    let head = setup.replacement;
    if (fault === "stale outcome") {
      selectedOutcome = setup.original;
    }
    if (fault === "unselected head") {
      head = "";
    }
    if (fault === "symbolic main") {
      f.git(["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    }
    if (fault === "foreign origin") {
      f.git(["remote", "set-url", "origin", f.remote]);
    }
    const result = selection(setup, selectedOutcome, head);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git(["rev-parse", outcomeRef])).toBe(outcome);
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it.each([
    ["merge-run", "123", "--current-workflow"],
    ["unknown", "123", "--current-workflow"],
    ["merge-recover", "123", "a".repeat(40), "--current-workflow"],
    [
      "merge-recover",
      "123",
      "a".repeat(40),
      "--confirmed-operator-recovery",
      "--body-file",
      "--current-workflow",
      "--replacement-head",
      "b".repeat(40),
    ],
  ])("rejects unsupported current-workflow invocation %j", (...args) => {
    const result = spawnSync("bash", ["scripts/pr", ...args], {
      env: createIndependentPrFixtureEnv(),
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--current-workflow requires confirmed merge-recover");
  });
});
