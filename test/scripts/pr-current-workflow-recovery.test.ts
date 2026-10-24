import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
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

type MergeFixture = ReturnType<typeof fixture>;

function publishCurrentWorkflow(f: MergeFixture, parent: string, source: string) {
  const directory = join(f.root, "selected-source");
  const current = sourceCommit(f, parent, directory, true);
  f.git(["push", "-q", "origin", `${current}:refs/heads/main`]);
  f.git(["fetch", "-q", "origin", "main"]);
  f.workflowSource(source, directory);
  // Qualify the canonical product source without allowing public Git transport.
  f.git([
    "config",
    "--add",
    `url.file://${f.remote}.insteadOf`,
    "https://github.com/openclaw/openclaw",
  ]);
  f.git(["remote", "set-url", "origin", "https://github.com/openclaw/openclaw"]);
  return { directory, current };
}

function recoverCurrent(f: MergeFixture, outcome: string, replacement = "", admin = false) {
  return f.run(
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
    admin ? f.path : "",
    admin,
    "",
    "",
    true,
  );
}

function expectBinding(f: MergeFixture, binding: string, outcome?: string) {
  expect(f.git(["rev-parse", bindingRef])).toBe(binding);
  if (outcome) {
    expect(f.git(["rev-parse", outcomeRef])).toBe(outcome);
  }
}

function sourceCommit(
  f: ReturnType<typeof fixture>,
  parent: string,
  directory: string,
  current: boolean,
) {
  copyPrWrapperSources(directory);
  writeFileSync(join(directory, "owner.txt"), f.git(["show", `${parent}:owner.txt`]) + "\n");
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
  const paths = readdirSync(directory, { recursive: true, withFileTypes: true })
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
  const { directory } = publishCurrentWorkflow(f, main, source);
  configureMerge(f, { mode: "success", pr: { mergeStateStatus: "CLEAN" } });
  return { f, outcome, binding, replacement, original, source, directory };
});

function nativeRecovery(f: MergeFixture, args: string[]) {
  const script = join(f.repo, "scripts/pr");
  mkdirSync(join(f.repo, "scripts"), { recursive: true });
  writeFileSync(script, wrapper);
  return spawnSync("bash", [script, ...args], {
    cwd: f.repo,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "file",
    },
    encoding: "utf8",
  });
}

const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
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
  const { directory, current } = publishCurrentWorkflow(f, source, source);
  f.useScripts(join(directory, "scripts"));
  configureMerge(f, { restMergeRefusal: "", comment: "lost" });
  return { f, outcome, binding, source, current };
});

function recoverAdmin(setup: ReturnType<typeof rejectedAdmin>) {
  return recoverCurrent(setup.f, setup.outcome, "", true);
}

describePosix("current-main recovery of a retained workflow", () => {
  it("native entrypoint admits only the explicit admin shape and refuses a stale outcome before execution", () => {
    const { f, outcome, binding } = rejectedAdmin();
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
    const invoke = (argv: string[]) => nativeRecovery(f, argv);
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
    expectBinding(f, binding, outcome);
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
    expectBinding(f, binding);
    expectAncestors(f, [outcome, binding, source, current], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);
  });

  it("retains the binding and cancelled history through real recovery and ordinary reconciliation", () => {
    const setup = cancelled();
    const { f, outcome, binding, replacement, original, source, directory } = setup;
    const captures = f.captures();
    const main = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    // Lost comment acknowledgement leaves ordinary reconciliation meaningful.
    configureMerge(f, { comment: "lost" });
    f.useScripts(join(directory, "scripts"));
    const recovery = recoverCurrent(f, outcome, replacement);
    expectExit(recovery, 1);
    const successor = f.git(["rev-parse", outcomeRef]);
    expect(f.record(), recovery.output).toMatchObject({
      phase: "commenting",
      head: replacement,
      recovery: { outcome, replacementHead: replacement },
      workflowRecovery: { binding, from: source, to: main },
    });
    expectBinding(f, binding);
    expectAncestors(f, [original, outcome, binding, source, main], outcomeRef);
    expectCapturedFiles(f, captures, outcomeRef);
    f.recover();
    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "commented" });
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
    expectBinding(f, binding);
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
      const result = recoverCurrent(f, outcome, replacement);
      expectExit(result, 1);
      expect(result.output).toMatch(
        fault === "source"
          ? /Current main workflow changed/
          : fault === "outcome"
            ? /outcome changed/
            : /head|prepared/i,
      );
      expectBinding(f, binding, fault === "outcome" ? original : outcome);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it.each(["unselected head", "symbolic main", "foreign origin", "unconfirmed cancellation"])(
    "refuses %s before source admission",
    (fault) => {
      const setup = cancelled(fault !== "unconfirmed cancellation");
      const { f, outcome, binding } = setup;
      let head = setup.replacement;
      if (fault === "unselected head") {
        head = "";
      }
      if (fault === "symbolic main") {
        f.git(["symbolic-ref", "refs/remotes/origin/main", "refs/heads/main"]);
      }
      if (fault === "foreign origin") {
        f.git(["remote", "set-url", "origin", f.remote]);
      }
      const result = nativeRecovery(f, [
        "merge-recover",
        "123",
        outcome,
        "--confirmed-operator-recovery",
        "--current-workflow",
        ...(head
          ? ["--replacement-head", head]
          : ["--admin-evidence", f.path, "--confirmed-operator-admin"]),
      ]);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toMatch(
        fault === "symbolic main"
          ? /Refusing symbolic or unreadable current workflow anchor/
          : fault === "foreign origin"
            ? /requires official current main and a retained workflow/
            : /requires a confirmed cancelled nonqueue auto outcome/,
      );
      expectBinding(f, binding, outcome);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it.each([
    ["merge-run", "123", "--current-workflow"],
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
