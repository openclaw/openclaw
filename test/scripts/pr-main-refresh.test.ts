import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { assertFixtureProcessGroupStopped } from "./exited-descendant-reaper.test-support.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const fixture = () => createMainRefreshFixture(tempDirs.make("openclaw-pr-main-refresh-"));

function recoverFixtureLock(f: ReturnType<typeof fixture>, oid: string) {
  const pgid = Number(/^pgid=(\d+)$/m.exec(f.git(f.canonical, "cat-file", "blob", oid))?.[1]);
  expect(pgid).toBeGreaterThan(1);
  assertFixtureProcessGroupStopped(pgid);
  const result = f.run(["lock-recover", "42", oid, "--confirmed-no-running-tools"]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(
    f.git(
      f.canonical,
      "for-each-ref",
      "--format=%(refname)",
      "refs/openclaw/pr-operation-locks/42",
    ),
  ).toBe("");
}

describePosix("native PR main refresh boundaries", () => {
  it.each([
    "review-init",
    "review-checkout-pr",
    "prepare-init",
    "prepare-run",
    "prepare-sync-head",
    "merge-verify",
  ])("%s acquires the authenticated head despite a stale pull ref", (command) => {
    const f = fixture();
    if (command === "prepare-sync-head" || command === "merge-verify") {
      const prepared = f.run("prepare-run");
      expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    }
    f.git(f.origin, "update-ref", "refs/pull/42/head", f.main);
    const result = f.run(command);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(f.worktree, "rev-parse", "refs/heads/pr-42")).toBe(f.head);
    expect(f.git(f.origin, "rev-parse", "refs/pull/42/head")).toBe(f.main);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(f.head);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(f.events().filter((event) => event.kind === "unexpected-push")).toEqual([]);
  });

  it.each(
    (["prepare-init", "merge-verify"] as const).flatMap((command) =>
      (["oid", "branch", "repository"] as const).map((boundary) => ({ command, boundary })),
    ),
  )(
    "rejects PR $boundary drift during $command acquisition without changing preparation stamps",
    ({ command, boundary }) => {
      const f = fixture();
      if (command === "merge-verify") {
        f.seedPreparedMerge();
      }
      const prepContext = join(f.local, "prep-context.env");
      const beforePrepContext = existsSync(prepContext)
        ? readFileSync(prepContext, "utf8")
        : undefined;
      f.configure({ prIdentityDriftAfterFetch: boundary });
      const result = f.run(command);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("PR head changed");
      expect(existsSync(prepContext) ? readFileSync(prepContext, "utf8") : undefined).toBe(
        beforePrepContext,
      );
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      expect(f.events().filter((event) => event.kind === "unexpected-push")).toEqual([]);
    },
  );

  it("refuses a non-SHA PR source before fetching or replacing its local ref", () => {
    const f = fixture();
    f.git(f.canonical, "branch", "pr-42", f.head);
    f.configure({ metadata: { ...f.metadata, headRefOid: "refs/heads/main" } });
    const result = f.run("review-init");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("Invalid PR identity for #42");
    expect(result.stderr).toContain("complete base/head OIDs and refs");
    expect(f.git(f.worktree, "rev-parse", "refs/heads/pr-42")).toBe(f.head);
    expect(existsSync(join(f.local, "review-context.env"))).toBe(false);
  });

  it.each(["detached", "pr-42", "pr-42-prep"])(
    "prepares directly from the reviewed head (%s) without visiting main",
    (branch) => {
      const f = fixture();
      f.git(f.canonical, "branch", "temp/pr-42", f.sameTreeHead);
      if (branch !== "detached") {
        f.git(f.worktree, "checkout", "-B", branch, f.head);
      }
      writeFileSync(join(f.canonical, "src/subject.ts"), "unrelated shared-checkout work\n");
      const sharedDiff = f.git(f.canonical, "diff", "HEAD");
      const review = readFileSync(join(f.local, "review.md"), "utf8");
      const result = f.run("prepare-init", "bash", f.worktree);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.git(f.worktree, "branch", "--show-current")).toBe("pr-42-prep");
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      expect(f.git(f.canonical, "rev-parse", "temp/pr-42")).toBe(f.sameTreeHead);
      expect(f.git(f.canonical, "diff", "HEAD")).toBe(sharedDiff);
      expect(readFileSync(join(f.local, "review.md"), "utf8")).toBe(review);
      expect(existsSync(join(f.local, "review-transition.json"))).toBe(false);
      const checkouts = f.events().filter((e) => e.args?.[0] === "checkout");
      expect(checkouts.length).toBeGreaterThan(0);
      expect(checkouts.every((e) => e.args?.at(-1) === f.head)).toBe(true);
      expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(1);
      expect(
        f
          .events()
          .some(
            (event) =>
              event.kind === "gh" &&
              event.args?.some((arg) => /\/(?:files|check-runs|status)\?/.test(arg)),
          ),
      ).toBe(false);
    },
  );

  it.each(["staged", "unstaged", "untracked", "unmerged"])(
    "refuses same-head preparation with %s foreign state",
    (state) => {
      const f = fixture();
      if (state === "unmerged") {
        expect(() => f.git(f.worktree, "merge", f.movedMain)).toThrow();
      } else {
        const path = state === "untracked" ? "foreign.txt" : "src/subject.ts";
        writeFileSync(join(f.worktree, path), "foreign data\n");
        if (state === "staged") {
          f.git(f.worktree, "add", path);
        }
      }
      const before = [
        f.git(f.worktree, "rev-parse", "HEAD"),
        f.git(f.worktree, "ls-files", "--stage"),
        f.git(f.worktree, "status", "--porcelain"),
        f.git(f.worktree, "diff", "HEAD"),
      ];
      const result = f.run("prepare-init");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("foreign state blocks a new transition");
      expect([
        f.git(f.worktree, "rev-parse", "HEAD"),
        f.git(f.worktree, "ls-files", "--stage"),
        f.git(f.worktree, "status", "--porcelain"),
        f.git(f.worktree, "diff", "HEAD"),
      ]).toEqual(before);
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
      expect(existsSync(join(f.local, "review-transition.json"))).toBe(false);
      expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    },
  );

  it.each(["detach", "fetch"])("recovers preparation after failed %s handoff", (failure) => {
    const f = fixture();
    f.git(f.worktree, "checkout", "-B", "pr-42", f.head);
    f.configure({ failDetach: failure === "detach", failPrFetch: failure === "fetch" });
    const failed = f.run("prepare-init");
    expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
    expect(failed.stderr).toContain("injected prepare handoff failure");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
    const journal = join(f.local, "review-transition.json");
    expect(existsSync(journal)).toBe(failure === "detach");
    if (failure === "detach") {
      expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({
        version: 1,
        pr: 42,
        source: f.head,
        target: f.head,
        mode: "detached",
        branch: null,
      });
    }
    const owner = f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42");
    expect(failed.stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
    recoverFixtureLock(f, owner);
    f.configure({ failDetach: false, failPrFetch: false });
    const result = f.run("prepare-init");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(f.worktree, "branch", "--show-current")).toBe("pr-42-prep");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(existsSync(journal)).toBe(false);
  });

  it("finishes an older main transition before rejecting a stale PR-head review", () => {
    const f = fixture();
    const journal = join(f.local, "review-transition.json");
    writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        pr: 42,
        source: f.head,
        target: f.main,
        mode: "detached",
        branch: null,
      }),
    );
    f.git(
      f.worktree,
      "restore",
      `--source=${f.main}`,
      "--staged",
      "--worktree",
      "--",
      "src/subject.ts",
    );
    const result = f.run("prepare-init");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout).toContain("expected HEAD at PR_HEAD_SHA");
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
  });

  it("completes supervised prepare with three fresh checkpoints and exact stamps", () => {
    const f = fixture();
    const result = f.run("prepare-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("prepare-run complete for PR #42");
    expect(result.stdout).toContain("Remote branch already at local prep HEAD; skipping push.");
    expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(3);
    const apiReads = f.events().filter((event) => event.kind === "gh" && event.args?.[0] === "api");
    expect(
      apiReads.filter((event) => event.args?.includes("repos/fixture/repo/pulls/42")),
    ).toHaveLength(5);
    expect(apiReads.filter((event) => event.args?.includes("user"))).toHaveLength(1);
    expect(apiReads.filter((event) => event.args?.includes("repos/fixture/repo"))).toEqual([]);
    const stamp = readFileSync(join(f.local, "prep.env"), "utf8");
    expect(stamp).toContain(`PREP_HEAD_SHA=${f.head}\n`);
    expect(stamp).toContain(`LOCAL_PREP_HEAD_SHA=${f.head}\n`);
    expect(stamp).toContain(`PREP_MAINLINE_BASE_SHA=${f.main}\n`);
    expect(stamp).toContain("PREP_REPLACED_HOSTED_ANCESTRY=false\n");
    expect(stamp).toContain("PREP_AUTHOR_ACCESS=maintainer\n");
    expect(readFileSync(join(f.local, "prep-context.env"), "utf8")).toContain(
      "PR_AUTHOR_ACCESS_AT_PREP=maintainer\n",
    );
    expect(
      f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
    ).toBe("");
    expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
    const lockWrites = f
      .events()
      .filter(
        (e) => e.kind === "git-decision" && e.args?.includes("refs/openclaw/pr-operation-locks/42"),
      );
    expect(lockWrites).toHaveLength(2);
    expect(lockWrites[1]?.args?.at(-1)).toBe(lockWrites[0]?.args?.at(-2));
    const runtimeCalls = f.events().filter((event) => event.kind === "git-runtime");
    expect(runtimeCalls.length).toBeGreaterThan(0);
    expect(
      runtimeCalls.every((event) =>
        event.args?.some((arg) => ["fetch", "checkout", "push"].includes(arg)),
      ),
    ).toBe(true);
  });

  it("retains the publication receipt and operation lock on mismatched receipt ownership", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    const receiptPath = join(f.local, "prep.env");
    const receipt = readFileSync(receiptPath, "utf8").replace("PR_NUMBER=42\n", "PR_NUMBER=43\n");
    writeFileSync(receiptPath, receipt);
    const result = f.run("prepare-sync-head");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("Retaining the operation lock for PR #42");
    expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(f.head);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
  });

  it("retires prior publication evidence only after a fresh reviewed preparation", () => {
    const f = fixture();
    const firstPrepare = f.run("prepare-run");
    expect(firstPrepare.status, firstPrepare.stdout + firstPrepare.stderr).toBe(0);
    f.git(f.worktree, "commit", "--allow-empty", "-qm", "reviewed fixup");
    const published = f.git(f.worktree, "rev-parse", "HEAD");
    const gitShim = join(f.root, "bin", "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const updateMetadata = [
      'const fs = require("node:fs")',
      "const file = process.argv[1]",
      'const control = JSON.parse(fs.readFileSync(file, "utf8"))',
      "control.metadata.headRefOid = process.argv[2]",
      "fs.writeFileSync(file, JSON.stringify(control))",
    ].join(";");
    // Allow exactly this publication through real Git, then expose its new
    // PR ref and metadata through the existing synthetic GitHub boundary.
    writeFileSync(
      gitShim,
      `#!/bin/sh
if [ "$1" = push ] && [ "$2" = "--force-with-lease=refs/heads/topic:${f.head}" ] && [ "$4" = "${published}:refs/heads/topic" ]; then
  "${realGit}" "$@" || exit "$?"
  "${realGit}" -C "${f.origin}" update-ref refs/pull/42/head "${published}" || exit "$?"
  "${process.execPath}" -e '${updateMetadata}' "${join(f.root, "control.json")}" "${published}"
  exit "$?"
fi
${readFileSync(gitShim, "utf8")}
`,
    );
    f.env.OPENCLAW_PR_PUSH_MODE = "git";
    f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "1";
    const firstPublish = f.run("prepare-sync-head");
    expect(firstPublish.status, firstPublish.stdout + firstPublish.stderr).toBe(0);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(published);
    const artifacts = [
      "prep-context.env",
      "prep.env",
      "gates.env",
      "prepare-push-result.env",
      "prepare-sync-result.env",
      "prep.md",
    ];
    const priorEvidence = artifacts.map(
      (name) => [name, readFileSync(join(f.local, name), "utf8")] as const,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE=${f.head}\n`,
    );

    f.git(f.worktree, "commit", "--allow-empty", "-qm", "new contribution to review");
    const reviewed = f.git(f.worktree, "rev-parse", "HEAD");
    f.git(
      f.worktree,
      "push",
      "origin",
      `${reviewed}:refs/heads/topic`,
      `${reviewed}:refs/pull/42/head`,
    );
    f.configure({ metadata: { ...f.metadata, headRefOid: reviewed } });
    for (const command of ["review-init", "review-checkout-pr"]) {
      const result = f.run(command);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    for (const name of ["review.md", "review.json"]) {
      const path = join(f.local, name);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.head, reviewed));
    }
    const nextPrepare = f.run("prepare-run");
    expect(nextPrepare.status, nextPrepare.stdout + nextPrepare.stderr).toBe(0);
    expect(readFileSync(join(f.local, "prep-context.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE=${reviewed}\n`,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PREP_HEAD_SHA=${reviewed}\n`,
    );
    const retained = readdirSync(f.local).filter((name) => name.startsWith("prep-evidence."));
    expect(retained).toHaveLength(1);
    for (const directory of retained) {
      for (const [name, contents] of priorEvidence) {
        expect(readFileSync(join(f.local, directory, name), "utf8")).toBe(contents);
      }
    }
    const sync = f.run("prepare-sync-head");
    expect(sync.status, sync.stdout + sync.stderr).toBe(0);
    expect(f.git(f.origin, "rev-parse", "refs/heads/topic")).toBe(reviewed);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
  });

  it("completes supervised merge with two checkpoints and releases its exact lock after cleanup", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    const before = f.events().length;
    const result = f.run("merge-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("merge-run complete for PR #42");
    const landed = f.git(f.origin, "rev-parse", "refs/heads/main");
    expect(
      JSON.parse(f.git(f.canonical, "show", "refs/openclaw/pr-merge-outcomes/42:outcome.json")),
    ).toMatchObject({ phase: "complete", head: f.head, main: f.main, landed });
    expect(f.git(f.canonical, "rev-parse", `${landed}^{tree}`)).toBe(
      f.git(f.canonical, "rev-parse", `${f.head}^{tree}`),
    );
    expect(f.events().filter((e) => e.kind === "leased-cleanup")).toHaveLength(1);
    expect(f.events().filter((e) => e.kind === "unexpected-push")).toEqual([]);
    expect(
      f
        .events()
        .slice(before)
        .filter((e) => e.kind === "main-fetch"),
    ).toHaveLength(2);
    expect(existsSync(f.worktree)).toBe(false);
    expect(
      f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
    ).toBe("");
  });

  it.each([2, 3])(
    "retains the operation lock when checkpoint %s fails after preparation mutated state",
    (checkpoint) => {
      const f = fixture();
      f.configure({ failFetchAt: checkpoint });
      const result = f.run("prepare-run");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Retaining the operation lock for PR #42");
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(true);
      expect(existsSync(join(f.local, "gates.env"))).toBe(checkpoint === 3);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(f.events().filter((e) => e.kind === "main-fetch")).toHaveLength(checkpoint);
      expect(
        f.git(
          f.canonical,
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/pr-operation-locks",
        ),
      ).toBe("refs/openclaw/pr-operation-locks/42");
    },
  );

  it("refreshes gate and publication snapshots when a newly reviewed head rebuilds preparation", () => {
    const f = fixture();
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    f.configure({ metadata: { ...f.metadata, headRefOid: f.sameTreeHead } });
    f.git(
      f.canonical,
      "push",
      "origin",
      `${f.sameTreeHead}:refs/heads/topic`,
      `${f.sameTreeHead}:refs/pull/42/head`,
    );
    f.git(f.worktree, "fetch", "origin", "refs/pull/42/head:refs/heads/pr-42");
    for (const artifact of ["pr-meta.env", "pr-meta.json", "review.json", "review.md"]) {
      const path = join(f.local, artifact);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.head, f.sameTreeHead));
    }
    const before = f.events().length;
    const result = f.run("prepare-push");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("rerunning prepare gates before push");
    expect(
      f
        .events()
        .slice(before)
        .filter((e) => e.kind === "main-fetch"),
    ).toHaveLength(3);
    expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
      `HOSTED_GATES_TARGET_HEAD_SHA=${f.sameTreeHead}\n`,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PREP_HEAD_SHA=${f.sameTreeHead}\n`,
    );
  });

  it("keeps nested preparation coherent and refreshes after hosted gates", () => {
    const f = fixture();
    f.configure({ moveAfterFirstFetch: true, moveAtGate: true });
    const result = f.run("prepare-run", "bash", f.worktree);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain, f.gateMain]);
    const decisions = f
      .events()
      .filter((e) => e.kind === "git-decision")
      .map((e) => e.args?.join(" "));
    expect(decisions).toContain(`diff --name-only ${f.movedMain}...HEAD`);
    expect(decisions).toContain(`merge-base ${f.head} ${f.gateMain}`);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("keeps hosted membership on the gate snapshot when the API base advances only in the remote", () => {
    const f = fixture();
    const remoteOnlyBase = f.git(
      f.origin,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      `${f.main}^{tree}`,
      "-p",
      f.main,
      "-m",
      "test: remote-only main advancement",
    );
    f.configure({ remoteOnlyBase });
    const result = f.run("prepare-run");
    const events = f.events();
    const baseRead = events.findIndex((e) => e.kind === "remote-only-base");
    expect(events[baseRead]).toEqual({
      kind: "remote-only-base",
      sha: remoteOnlyBase,
      localObject: false,
    });
    expect(
      events
        .slice(0, baseRead)
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.main]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(events.filter((e) => e.kind === "fetched").map((e) => e.sha)).toEqual([
      f.main,
      f.main,
      remoteOnlyBase,
    ]);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(`PREP_HEAD_SHA=${f.head}\n`);
  });

  it.each(["review-checkout-main", "prepare-init"])(
    "%s preserves private FETCH_HEAD despite shared-ref writes and worktree origin/refmap overrides",
    (command) => {
      const f = fixture();
      const sharedFetchHead = join(f.canonical, ".git", "FETCH_HEAD");
      const readSharedFetchHead = () =>
        existsSync(sharedFetchHead) ? readFileSync(sharedFetchHead, "utf8") : null;
      const beforeSharedFetchHead = readSharedFetchHead();
      f.git(f.canonical, "remote", "set-url", "origin", "../origin.git");
      f.git(f.worktree, "config", "--worktree", "remote.origin.url", join(f.root, "wrong-origin"));
      f.git(
        f.worktree,
        "config",
        "--worktree",
        "remote.origin.fetch",
        "+refs/heads/movement:refs/remotes/origin/main",
      );
      f.git(f.canonical, "update-ref", "refs/heads/origin/main", f.movedMain);
      f.configure({ moveSharedAfterFetch: true });
      const result = f.run(command);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(
        command === "prepare-init" ? f.head : f.main,
      );
      expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(f.main);
      expect(readSharedFetchHead()).toBe(beforeSharedFetchHead);
      expect(f.events().filter((e) => e.kind === "fetched")).toEqual([
        { kind: "fetched", sha: f.main, shared: f.movedMain },
      ]);
      expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(f.movedMain);
    },
  );

  it.each([
    { filter: "blob:none", smallIncluded: false, largeIncluded: false },
    { filter: "blob:limit=64", smallIncluded: true, largeIncluded: false },
    { filter: undefined, smallIncluded: true, largeIncluded: true },
  ])(
    "retains canonical fetch filtering ($filter) without changing Git config or shared checkpoints",
    ({ filter, smallIncluded, largeIncluded }) => {
      const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-main-filter-"), {
        partialCloneFilter: filter,
      });
      symlinkSync(f.origin, join(f.root, "origin=filter.git"));
      f.git(f.canonical, "remote", "set-url", "origin", "../origin=filter.git");
      if (!filter) {
        f.git(f.canonical, "config", "remote.origin.promisor", "false");
        f.git(f.canonical, "config", "remote.origin.partialclonefilter", "blob:none");
      }
      f.git(f.worktree, "config", "--worktree", "remote.origin.url", join(f.root, "wrong-origin"));
      f.git(
        f.worktree,
        "config",
        "--worktree",
        "remote.origin.promisor",
        filter ? "false" : "true",
      );
      f.git(
        f.worktree,
        "config",
        "--worktree",
        "remote.origin.partialclonefilter",
        "blob:limit=1m",
      );
      f.git(
        f.worktree,
        "config",
        "--worktree",
        "remote.origin.fetch",
        "+refs/heads/topic:refs/remotes/origin/main",
      );
      const commonConfig = join(f.canonical, ".git", "config");
      const worktreeConfig = join(
        f.git(f.worktree, "rev-parse", "--absolute-git-dir"),
        "config.worktree",
      );
      const beforeConfig = [commonConfig, worktreeConfig].map((path) => readFileSync(path, "utf8"));
      const sharedFetchHead = join(f.canonical, ".git", "FETCH_HEAD");
      writeFileSync(sharedFetchHead, "unrelated shared checkpoint\n");
      const author = join(f.root, "author");
      f.git(f.origin, "worktree", "add", "--detach", author, f.main);
      f.git(author, "config", "user.name", "OpenClaw Test");
      f.git(author, "config", "user.email", "test@example.invalid");
      const localObjects = () =>
        f
          .git(f.canonical, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
          .split("\n");
      let privateMain = "";
      let largeBlob = "";
      for (const phase of ["bootstrap", "main", "pr"]) {
        f.git(author, "checkout", "--detach", phase === "pr" ? f.head : f.main);
        writeFileSync(join(author, "small.txt"), `${phase}\n`);
        writeFileSync(join(author, "large.txt"), `${phase}\n`.repeat(1024));
        f.git(author, "add", "small.txt", "large.txt");
        f.git(author, "commit", "-qm", `test: remote ${phase} objects`);
        const head = f.git(author, "rev-parse", "HEAD");
        const smallBlob = f.git(author, "rev-parse", "HEAD:small.txt");
        largeBlob = f.git(author, "rev-parse", "HEAD:large.txt");
        f.git(
          f.origin,
          "update-ref",
          phase === "pr" ? "refs/heads/topic" : "refs/heads/main",
          head,
        );
        if (phase === "pr") {
          f.configure({ metadata: { ...f.metadata, headRefOid: head } });
        }
        const beforeObjects = localObjects();
        expect(beforeObjects).not.toContain(smallBlob);
        expect(beforeObjects).not.toContain(largeBlob);
        const command =
          phase === "bootstrap"
            ? "fetch_canonical_main refs/heads/temp/pr-42"
            : phase === "main"
              ? "cd .worktrees/pr-42\nrefresh_main_snapshot"
              : `cd .worktrees/pr-42\nfetch_pr_head 42 ${head} refs/heads/pr-42`;
        const result = f.shell(command);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const afterObjects = localObjects();
        expect(afterObjects.includes(smallBlob), `${phase} small blob`).toBe(smallIncluded);
        expect(afterObjects.includes(largeBlob), `${phase} large blob`).toBe(largeIncluded);
        if (phase === "main") {
          privateMain = head;
        } else {
          expect(
            f.git(
              f.canonical,
              "rev-parse",
              phase === "bootstrap" ? "refs/heads/temp/pr-42" : "refs/heads/pr-42",
            ),
          ).toBe(head);
        }
        if (privateMain) {
          expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(privateMain);
        }
        expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(f.main);
        expect(readFileSync(sharedFetchHead, "utf8")).toBe("unrelated shared checkpoint\n");
        expect([commonConfig, worktreeConfig].map((path) => readFileSync(path, "utf8"))).toEqual(
          beforeConfig,
        );
      }
      // Explicit object hydration must still retrieve bytes omitted by ref filtering.
      f.git(
        f.canonical,
        "fetch",
        "--no-auto-maintenance",
        "--no-tags",
        "--no-write-fetch-head",
        "../origin=filter.git",
        largeBlob,
      );
      expect(localObjects()).toContain(largeBlob);
    },
  );

  it("starts a new operation fresh and rejects a stale detached main review", () => {
    const f = fixture();
    expect(f.run("review-checkout-main").status).toBe(0);
    f.git(f.origin, "update-ref", "refs/heads/main", f.movedMain);
    const result = f.run("review-guard");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout).toContain(`expected HEAD at origin/main (${f.movedMain})`);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
  });

  it("preserves foreign checkout-hook changes when cold review initialization requests a reset", () => {
    const f = fixture();
    f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
    const hooks = join(f.canonical, ".git", "hooks");
    writeFileSync(
      join(hooks, "post-checkout"),
      "#!/bin/sh\nprintf 'foreign checkout-hook change\\n' > src/subject.ts\n",
      { mode: 0o755 },
    );
    f.git(f.canonical, "config", "core.hooksPath", hooks);
    const result = f.run("review-init");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("foreign state blocks a new transition");
    expect(f.git(f.worktree, "status", "--short")).toBe("M src/subject.ts");
    expect(readFileSync(join(f.worktree, "src/subject.ts"), "utf8")).toBe(
      "foreign checkout-hook change\n",
    );
    expect(f.git(f.canonical, "status", "--short")).toBe("");
  });

  it("uses the private checkpoint after an uninterrupted cold bootstrap while main moves", () => {
    const f = fixture();
    f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
    f.git(f.canonical, "checkout", "--detach", f.head);
    f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
    f.configure({ moveAfterFirstFetch: true });
    const result = f.run("review-checkout-main");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain]);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
    expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
    expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.head);
  });

  it.each([1, 2])(
    "provisions without a local main anchor and retries cold fetch %s failure",
    (fetchNumber) => {
      const f = fixture();
      f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
      f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
      f.configure({ failFetchAt: fetchNumber });
      const failed = f.run("review-checkout-main");
      expect(failed.status).not.toBe(0);
      expect(existsSync(f.worktree)).toBe(fetchNumber === 2);
      if (fetchNumber === 2) {
        expect(f.git(f.worktree, "symbolic-ref", "HEAD")).toBe("refs/heads/temp/pr-42");
        expect(f.git(f.canonical, "rev-parse", "refs/heads/temp/pr-42")).toBe(f.main);
        expect(f.git(f.worktree, "write-tree")).toBe(
          f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
        );
        expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      }
      const owner = f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42");
      expect(failed.stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
      recoverFixtureLock(f, owner);
      f.configure({ failFetchAt: 0 });
      const result = f.run("review-checkout-main");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.main);
      expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
    },
  );

  it("invalidates the previous snapshot when the same operation provisions a new worktree", () => {
    const f = fixture();
    f.configure({ moveAfterFirstFetch: true });
    const result = f.shell(
      `
acquire_pr_operation_lock 42
enter_worktree 42 false
printf 'first=%s\\n' "$PR_MAIN_SHA"
cd "$(repo_root)"
git worktree remove --force .worktrees/pr-42
enter_worktree 42 false
printf 'replacement=%s\\n' "$PR_MAIN_SHA"
`,
      { supervised: true },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`first=${f.main}\n`);
    expect(result.stdout).toContain(`replacement=${f.movedMain}\n`);
    expect(
      f
        .events()
        .filter((e) => e.kind === "fetched")
        .map((e) => e.sha),
    ).toEqual([f.main, f.movedMain, f.movedMain]);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
    expect(
      f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks"),
    ).toBe("");
  });

  it.each([
    { phase: "bootstrap", fetchNumber: 1 },
    { phase: "private", fetchNumber: 2 },
  ])(
    "recovers cold $phase fetch interruption through the native exact owner",
    async ({ fetchNumber }) => {
      const f = fixture();
      f.git(f.canonical, "worktree", "remove", "--force", f.worktree);
      f.git(f.canonical, "checkout", "--detach", f.head);
      f.git(f.canonical, "update-ref", "-d", "refs/remotes/origin/main");
      f.git(f.canonical, "update-ref", "refs/heads/origin/main", f.head);
      const readyPath = join(f.root, "fetch-ready.fifo");
      const holdPath = join(f.root, "fetch-hold.fifo");
      execFileSync("mkfifo", [readyPath, holdPath]);
      f.env.OPENCLAW_TEST_FETCH_READY = readyPath;
      f.env.OPENCLAW_TEST_FETCH_HOLD = holdPath;
      writeFileSync(
        join(f.root, "hold-upload-pack"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$$" "$(ps -o pgid= -p "$$")" > "$OPENCLAW_TEST_FETCH_READY"
read -r release < "$OPENCLAW_TEST_FETCH_HOLD"
`,
        { mode: 0o755 },
      );
      f.configure({ pauseFetchAt: fetchNumber });
      const reader = createReadStream(readyPath, { encoding: "utf8" });
      const ready = new Promise<string>((resolve, reject) => {
        let data = "";
        reader.on("data", (chunk) => {
          data += chunk.toString();
          const newline = data.indexOf("\n");
          if (newline >= 0) {
            resolve(data.slice(0, newline));
          }
        });
        reader.once("error", reject);
      });
      const controller = spawn(
        "bash",
        [join(f.canonical, "scripts/pr"), "review-checkout-main", "42"],
        {
          cwd: f.canonical,
          env: f.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      controller.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      controller.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        controller.once("error", reject);
        controller.once("close", resolve);
      });
      const lockRef = "refs/openclaw/pr-operation-locks/42";
      const ownerFields = (oid: string) =>
        Object.fromEntries(
          f
            .git(f.canonical, "cat-file", "blob", oid)
            .split("\n")
            .map((line) => line.split("=")),
        );
      try {
        const handshake = await Promise.race([
          ready,
          exited.then((code) => {
            throw new Error(`Exited before fetch readiness: ${code}\n${stdout}${stderr}`);
          }),
        ]);
        const [uploadPid, uploadPgid] = handshake.split("\t").map(Number);
        const owner = f.git(f.canonical, "rev-parse", lockRef);
        const fields = ownerFields(owner);
        expect(uploadPid).toBeGreaterThan(1);
        expect(Number(fields.supervisor_pid)).toBe(controller.pid);
        expect(Number(fields.pgid)).toBe(uploadPgid);
        const initializedTree = existsSync(f.worktree)
          ? f.git(f.worktree, "write-tree")
          : undefined;
        const indexExists =
          existsSync(f.worktree) &&
          existsSync(join(f.git(f.worktree, "rev-parse", "--absolute-git-dir"), "index"));
        f.git(f.origin, "update-ref", "refs/heads/main", f.movedMain);
        controller.kill("SIGTERM");
        expect(await exited, stdout + stderr).toBe(143);
        expect(f.git(f.canonical, "rev-parse", lockRef)).toBe(owner);
        expect(stderr).toContain(`lock-recover 42 ${owner} --confirmed-no-running-tools`);
        recoverFixtureLock(f, owner);
        f.configure({ pauseFetchAt: 0 });
        const retry = f.run("review-checkout-main");
        const retryOwner = f.git(f.canonical, "for-each-ref", "--format=%(objectname)", lockRef);
        if (retryOwner) {
          recoverFixtureLock(f, retryOwner);
        }
        expect(retry.status, retry.stdout + retry.stderr).toBe(0);
        expect(initializedTree).toBe(
          fetchNumber === 1 ? undefined : f.git(f.canonical, "rev-parse", `${f.main}^{tree}`),
        );
        expect(indexExists).toBe(fetchNumber === 2);
        expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.movedMain);
        expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
        expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.head);
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) {
          controller.kill("SIGTERM");
        }
        await exited;
        // Unblock a pending FIFO open/read even if the wrapper exited before the handshake.
        const fd = openSync(readyPath, constants.O_RDWR);
        writeSync(fd, "\n");
        closeSync(fd);
        reader.destroy();
      }
    },
  );

  it.each(["metadata", "fetched", "branch"] as const)(
    "rejects changed exact PR identity at %s before preparation stamps",
    (boundary) => {
      const f = fixture();
      expect(f.git(f.canonical, "rev-parse", `${f.head}^{tree}`)).toBe(
        f.git(f.canonical, "rev-parse", `${f.sameTreeHead}^{tree}`),
      );
      if (boundary === "metadata") {
        f.configure({ metadata: { ...f.metadata, headRefOid: f.sameTreeHead } });
      }
      if (boundary === "branch") {
        f.configure({ metadata: { ...f.metadata, headRefName: "renamed" } });
      }
      if (boundary === "fetched") {
        f.configure({ wrongPrFetch: true });
      }
      const result = f.run("prepare-run");
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        boundary === "branch" ? "PR head branch changed" : "PR head changed",
      );
      expect(existsSync(join(f.local, "prep-context.env"))).toBe(false);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.worktree, "status", "--porcelain")).toBe("");
      expect(f.events().some((e) => e.kind === "hosted-gate")).toBe(false);
    },
  );

  it.each([false, true])(
    "refreshes after CI and required checks with strict drift=%s",
    (strict) => {
      const f = fixture();
      const prepare = f.run("prepare-run");
      expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
      // This case owns the nonhosted watcher's post-wait refresh contract.
      writeFileSync(join(f.local, "gates.env"), "GATES_MODE=full\n");
      f.configure({ moveAtCi: true });
      if (strict) {
        f.env.OPENCLAW_PR_STRICT_DRIFT = "1";
      }
      const before = f.events().length;
      const result = f.run("merge-verify");
      expect(result.status, result.stdout + result.stderr).toBe(strict ? 1 : 0);
      expect(result.stdout).toContain(
        strict ? "Merge verify failed: mainline drift" : "WARNING — mainline drift",
      );
      const events = f.events().slice(before);
      expect(events.filter((e) => e.kind === "fetched").map((e) => e.sha)).toEqual([
        f.main,
        f.movedMain,
      ]);
      const checks = events.findIndex((e) => e.kind === "required-checks");
      expect(events.findIndex((e) => e.kind === "ci-completed")).toBeLessThan(checks);
      expect(events.findLastIndex((e) => e.kind === "main-fetch")).toBeGreaterThan(checks);
    },
  );

  it.each([
    {
      name: "exact punctuation and case overlaps",
      preparedPaths: ["src/A-file.ts", "src/a_file.ts", "src/Mixed.Case.ts"],
      mainPaths: ["src/A-file.ts", "src/a_file.ts", "src/Mixed.Case.ts"],
      overlaps: ["src/A-file.ts", "src/Mixed.Case.ts", "src/a_file.ts"],
    },
    {
      name: "case-only nonmatches",
      preparedPaths: ["src/Case-file.ts"],
      mainPaths: ["src/case-file.ts"],
      overlaps: [],
    },
  ])(
    "evaluates $name in C locale without changing its caller",
    ({ preparedPaths, mainPaths, overlaps }) => {
      const f = fixture();
      const commitPaths = (base: string, paths: string[], label: string) => {
        f.git(f.canonical, "checkout", "--detach", base);
        for (const path of paths) {
          writeFileSync(join(f.canonical, path), `${label}\n`);
        }
        f.git(f.canonical, "add", "--", ...paths);
        f.git(f.canonical, "commit", "-qm", label);
        return f.git(f.canonical, "rev-parse", "HEAD");
      };
      const preparedHead = commitPaths(f.head, preparedPaths, "test: prepared paths");
      const incomingMain = commitPaths(f.main, mainPaths, "test: incoming paths");
      f.git(
        f.canonical,
        "push",
        "origin",
        `${preparedHead}:refs/heads/topic`,
        `${preparedHead}:refs/pull/42/head`,
        `${incomingMain}:refs/heads/main`,
      );
      f.git(f.canonical, "checkout", "--detach", f.main);
      f.git(f.worktree, "checkout", "--detach", preparedHead);
      f.configure({ metadata: { ...f.metadata, headRefOid: preparedHead } });
      for (const artifact of ["pr-meta.json", "pr-meta.env", "review.json", "review.md"]) {
        const path = join(f.local, artifact);
        writeFileSync(path, readFileSync(path, "utf8").replaceAll(f.head, preparedHead));
      }
      const prepared = f.run("prepare-run");
      expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);

      const trace = join(f.root, "drift-locales.log");
      f.env.LC_ALL = "en_US.UTF-8";
      f.env.DRIFT_LOCALE_TRACE = trace;
      for (const command of ["sort", "comm"]) {
        const realCommand = `DRIFT_REAL_${command.toUpperCase()}`;
        f.env[realCommand] = execFileSync("which", [command], { encoding: "utf8" }).trim();
        writeFileSync(
          join(f.root, "bin", command),
          `#!/bin/sh
if [ "\${DRIFT_LOCALE_PROBE:-}" = 1 ]; then
  printf '%s\\t%s\\n' '${command}' "\${LC_ALL:-}" >> "$DRIFT_LOCALE_TRACE"
fi
LC_ALL=C exec "$${realCommand}" "$@"
`,
          { mode: 0o755 },
        );
      }
      // Observe the actual evaluator's subprocess environment, not host collation behavior.
      const result = f.shell(`
eval "$(declare -f mainline_drift_requires_sync | sed '1s/mainline_drift_requires_sync/evaluate_actual_drift/')"
mainline_drift_requires_sync() {
  local DRIFT_LOCALE_PROBE=1
  export DRIFT_LOCALE_PROBE
  evaluate_actual_drift "$@"
}
merge_verify 42 '{"replacementHead":"","autoMergeRequested":false,"observation":null,"qualifiedRefusal":false}' || exit 1
printf 'caller-locale=%s\\n' "$LC_ALL"
`);
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(0);
      expect(output).toContain("caller-locale=en_US.UTF-8\n");
      expect(output).not.toContain("Mainline files touching merge-critical infrastructure");
      if (overlaps.length > 0) {
        expect(output).toContain(
          `Mainline files overlapping prepared files (${overlaps.length}):\n${overlaps.map((path) => `  - ${path}`).join("\n")}\n`,
        );
        expect(output).toContain("WARNING — mainline drift");
      } else {
        expect(output).not.toContain("Mainline files overlapping prepared files");
        expect(output).toContain("because behind-main drift is unrelated");
      }
      expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
      expect(f.events().some((event) => event.kind === "gh" && event.args?.includes("merge"))).toBe(
        false,
      );
      expect(
        f.git(
          f.canonical,
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/pr-merge-outcomes/42",
        ),
      ).toBe("");
      expect(f.git(f.origin, "rev-parse", "refs/heads/main")).toBe(incomingMain);
      expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        "sort\tC",
        "sort\tC",
        "comm\tC",
      ]);
    },
  );

  it.each([
    [
      "commit read",
      'pr_git() { if [ "${DRIFT_FAULT_ACTIVE:-}" = 1 ] && [ "$1" = cat-file ]; then return 1; fi; command git "$@"; }',
    ],
    [
      "scratch allocation",
      'mktemp() { [ "${DRIFT_FAULT_ACTIVE:-}" != 1 ] || return 1; command mktemp "$@"; }',
    ],
    [
      "mainline diff",
      'pr_git() { if [ "${DRIFT_FAULT_ACTIVE:-}" = 1 ] && [ "$1" = diff ] && [[ "$3" = *"$PR_MAIN_SHA" ]]; then return 1; fi; command git "$@"; }',
    ],
    [
      "prepared diff",
      'pr_git() { if [ "${DRIFT_FAULT_ACTIVE:-}" = 1 ] && [ "$1" = diff ] && [[ "$3" = *"$PREP_HEAD_SHA" ]]; then return 1; fi; command git "$@"; }',
    ],
    [
      "overlap read",
      'comm() { [ "${DRIFT_FAULT_ACTIVE:-}" != 1 ] || return 1; command comm "$@"; }',
    ],
    [
      "critical file write",
      'is_mainline_drift_critical_path_for_merge() { rm -f "$critical_file"; mkdir "$critical_file"; return 0; }',
    ],
    ["path read", 'read() { [ "${DRIFT_FAULT_ACTIVE:-}" != 1 ] || return 1; builtin read "$@"; }'],
    ["count read", 'wc() { [ "${DRIFT_FAULT_ACTIVE:-}" != 1 ] || return 1; command wc "$@"; }'],
    [
      "diagnostic read",
      'sed() { if [ "${DRIFT_FAULT_ACTIVE:-}" = 1 ] && [ "$1" = -n ]; then return 1; fi; command sed "$@"; }',
    ],
  ])("rejects drift %s failure before merge intent or dispatch", (_name, fault) => {
    const f = fixture();
    f.seedPreparedMerge();
    f.configure({ moveAtChecks: true });
    const result = f.shell(`
eval "$(declare -f mainline_drift_requires_sync | sed '1s/mainline_drift_requires_sync/evaluate_actual_drift/')"
mainline_drift_requires_sync() {
  local DRIFT_FAULT_ACTIVE=1
  evaluate_actual_drift "$@"
}
${fault}
# Stop an unfixed verifier before it could create even a synthetic merge intent.
prepare_squash_merge_body() { echo UNEXPECTED_AFTER_VERIFY >&2; return 99; }
merge_run 42 || exit 1
`);
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output, output).toContain("unable to evaluate mainline drift");
    expect(output).not.toContain("UNEXPECTED_AFTER_VERIFY");
    expect(output).not.toContain("because behind-main drift is unrelated");
    expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
    expect(
      f.events().some((e) => e.kind === "gh" && e.args?.[0] === "pr" && e.args[1] === "merge"),
    ).toBe(false);
    expect(
      f.git(
        f.canonical,
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/pr-merge-outcomes/42",
      ),
    ).toBe("");
    expect(f.git(f.origin, "rev-parse", "refs/heads/main")).toBe(f.movedMain);
    expect(readdirSync(f.root).filter((name) => name.startsWith("openclaw-pr-drift."))).toEqual([]);
  });

  it.each([false, true])("retains successful unrelated drift results (files=%s)", (hasFiles) => {
    const f = fixture();
    const result = f.shell(
      `PR_MAIN_SHA=${hasFiles ? f.movedMain : f.main}
if mainline_drift_requires_sync ${f.main} ${f.main}; then
  exit 99
else
  test "$?" -eq 1
fi`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(hasFiles ? "no overlap" : "no mainline changes");
    expect(readdirSync(f.root).filter((name) => name.startsWith("openclaw-pr-drift."))).toEqual([]);
  });

  it("rejects drift evaluation errors in strict mode", () => {
    const f = fixture();
    f.seedPreparedMerge();
    f.configure({ moveAtChecks: true });
    f.env.OPENCLAW_PR_STRICT_DRIFT = "1";
    const result = f.shell(
      `mainline_drift_requires_sync() { return 2; }\nmerge_verify 42 '{"replacementHead":"","autoMergeRequested":false,"observation":null,"qualifiedRefusal":false}' || exit 1`,
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("unable to evaluate mainline drift");
    expect(result.stdout).not.toContain("because behind-main drift is unrelated");
  });

  it("rejects a moved prepared branch without consuming CI proof", () => {
    const f = fixture();
    expect(f.run("prepare-run").status).toBe(0);
    const stamp = readFileSync(join(f.local, "prep.env"), "utf8");
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", f.sameTreeHead);
    const result = f.run("merge-verify");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Local prep branch moved after prepare-push");
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(stamp);
    expect(f.events().some((e) => e.kind === "ci-completed")).toBe(false);
  });

  it("invalidates a previous snapshot when the next checkpoint fails", () => {
    const f = fixture();
    f.configure({ failFetchAt: 2 });
    const result = f.shell(
      'enter_worktree 42 false\nif refresh_main_snapshot; then exit 99; fi\nprintf "snapshot=%s\\n" "$PR_MAIN_SHA"',
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("snapshot=\n");
    expect(f.events().filter((e) => e.kind === "fetched")).toHaveLength(1);
  });

  it("propagates authentication failure under an OR-list before any main fetch", () => {
    const f = fixture();
    f.configure({ failAuth: true });
    const result = f.shell("review_validate_artifacts 42 || exit 1\necho UNEXPECTED_SUCCESS");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub API preflight failed");
    expect(f.events().some((e) => e.kind === "main-fetch")).toBe(false);
  });

  it("stops native merge when both writer quotas are exhausted before fetch or dispatch and releases its lock", () => {
    const f = fixture();
    f.configure({ writerRateLimited: true });
    const result = f.run("merge-run");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("GitHub API request failed (resource=graphql)");
    expect(result.stderr).toContain("original response: HTTP 403");
    expect(result.stderr).toContain("resource=graphql; remaining=0; limit=unknown; reset=unknown");
    expect(result.stderr).not.toContain("Supplemental quota probe");
    expect(f.events().some((e) => e.kind === "main-fetch")).toBe(false);
    const ghCalls = f.events().filter((e) => e.kind === "gh");
    const apiCalls = ghCalls.filter((e) => e.args?.[0] === "api").map((e) => e.args);
    expect(apiCalls.at(-1)).toEqual([
      "api",
      "graphql",
      "--include",
      "-f",
      "query=query{viewer{login}}",
    ]);
    expect(apiCalls.filter((args) => args?.includes("rate_limit"))).toHaveLength(0);
    expect(apiCalls.filter((args) => args?.includes("user"))).toHaveLength(1);
    expect(apiCalls.filter((args) => args?.includes("graphql"))).toHaveLength(1);
    expect(ghCalls.some((e) => e.args?.includes("merge"))).toBe(false);
    expect(ghCalls.some((e) => e.args?.[0] === "workflow")).toBe(false);
    expect(f.git(f.origin, "rev-parse", "refs/heads/main")).toBe(f.main);
    expect(f.git(f.canonical, "for-each-ref", "--format=%(refname)", "refs/openclaw")).toBe("");
  });

  for (const command of [
    "enter_worktree 42 false",
    "review_guard 42",
    "review_validate_artifacts 42",
  ]) {
    it.each([false, true])(
      `propagates failed refresh through ${command} (OR-list=%s)`,
      (orList) => {
        const f = fixture();
        f.configure({ failFetch: true });
        const result = f.shell(`${command}${orList ? " || exit 1" : ""}\necho UNEXPECTED_SUCCESS`);
        expect(result.stderr).toContain("injected main fetch failure");
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stdout).not.toContain("UNEXPECTED_SUCCESS");
        expect(result.stdout).not.toContain("review artifacts validated");
        expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      },
    );
  }
});
