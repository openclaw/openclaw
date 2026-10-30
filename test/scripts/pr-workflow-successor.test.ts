import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const bindingRef = "refs/openclaw/pr-workflow-bindings/42";
const lockRef = "refs/openclaw/pr-operation-locks/42";
const retained = [
  "prep-context.env",
  "pr-meta.json",
  "pr-meta.env",
  "review.json",
  "correction-review.json",
  "correction-incoming-review.json",
  "prep.env",
];

function fixture(baseline = false) {
  const f = createBaselineFixture(temps.make("pr-workflow-successor-"), 1);
  if (baseline) {
    f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("baseline")));
    f.approve();
  }
  const head = f.prepGit("rev-parse", "HEAD");
  const tree = f.prepGit("rev-parse", "HEAD^{tree}");
  // Only this completed prep.env retains the GraphQL alias. There is no
  // push/sync result from which a successor could reconstruct its authority.
  const hosted = f.prepGit("commit-tree", "-S", tree, "-p", f.incoming, "-m", "Hosted alias");
  f.git(f.repo, "update-ref", "refs/heads/topic", hosted);
  f.preparePublication();
  const complete = spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      `
set -euo pipefail
source "$1/scripts/pr-lib/prepare-core.sh"
source .local/prep-context.env
source .local/gates.env
PR_AUTHOR=fixture
PUSH_REPLACED_HOSTED_ANCESTRY=false
resolve_contributor_coauthor_email() { return 1; }
complete_prepare_push "$2" "$3" "$4" "$4" "$2"
`,
      "complete-fixture",
      f.repo,
      hosted,
      head,
      f.incoming,
    ],
    { cwd: f.worktree, env: f.env, encoding: "utf8" },
  );
  expectExit(complete, 0);
  f.writeLocal("gates-build.log", "previous exact-head build\n");
  const binding = f.git(f.repo, "rev-parse", bindingRef);
  const source = JSON.parse(f.git(f.repo, "show", `${binding}:binding.json`)).source as string;
  writeFileSync(join(f.repo, "workflow-version"), "repaired workflow\n");
  f.git(f.repo, "add", "workflow-version");
  f.git(f.repo, "commit", "-qm", "fix: workflow successor fixture");
  const current = f.git(f.repo, "rev-parse", "HEAD");
  // Authenticate the official source spelling while keeping every transport
  // inside the fixture's real local Git repository.
  f.git(
    f.repo,
    "config",
    "--add",
    `url.${f.repo}.insteadOf`,
    "https://github.com/openclaw/openclaw.git",
  );
  f.git(f.repo, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
  f.git(f.repo, "fetch", "-q", "origin", "main");
  const review = f.prepGit("hash-object", "--no-filters", f.local("correction-review.json"));
  const values = {
    "--expected-binding": binding,
    "--from-workflow": source,
    "--to-workflow": current,
    "--expected-head": head,
    "--expected-tree": tree,
    "--expected-review": review,
    "--expected-hosted-head": hosted,
  };
  const args = (overrides: Partial<typeof values> = {}) =>
    Object.entries({ ...values, ...overrides }).flat();
  const files = f.snapshot([...retained, ...(baseline ? ["prepare-baseline.json"] : [])]);
  const originalGate = f.readLocal("gates.env");
  const unchanged = () => {
    f.expectSnapshot(files);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(head);
    expect(f.prepGit("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(f.prepGit("status", "--porcelain", "--untracked-files=no")).toBe("");
    f.prepGit("verify-commit", head);
    f.prepGit("verify-commit", hosted);
    f.git(f.repo, "verify-commit", current);
  };
  const transition = (extra: NodeJS.ProcessEnv = {}) =>
    f.run("prepare-workflow-successor", args(), extra);
  return {
    ...f,
    binding,
    source,
    current,
    head,
    tree,
    hosted,
    review,
    args,
    unchanged,
    transition,
    originalGate,
  };
}

function expectExit(result: ReturnType<typeof spawnSync>, status: number) {
  expect(result.status, `${String(result.stdout)}${String(result.stderr)}`).toBe(status);
}

function verifyPublishedMerge(f: ReturnType<typeof fixture>) {
  const observation = {
    ...JSON.parse(f.readLocal("pr-meta.json").toString()),
    headRefOid: f.hosted,
    isDraft: false,
  };
  return spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      `set -euo pipefail
script_parent_dir="$1/scripts"
for owner in worktree common gates push review prepare-core merge; do
  source "$script_parent_dir/pr-lib/$owner.sh"
done
PR_MAIN_SHA="$2"
# Reuse the already entered native checkout. Only external observations are
# fixture responses; merge's review, alias, gate and source guards stay real.
enter_worktree() { :; }
mark_pr_operation_side_effects_started() { :; }
refresh_main_snapshot() { :; }
fetch_pr_head() {
  test "$2" = "$(git -C "$FIXTURE_REPO" rev-parse topic)" || return 1
  git update-ref "$3" "$2"
  PR_HEAD_OBSERVATION="$4"
}
merge_read() {
  test "$1" = checks && test "$PREP_HEAD_SHA" = "$(git -C "$FIXTURE_REPO" rev-parse topic)" || return 1
  printf '%s\\n' "$PREP_HEAD_SHA" >.local/merge-check-target
  printf '%s\\n' '{"transport":"graphql","payload":[{"name":"openclaw/ci-gate","bucket":"pass","state":"SUCCESS"}]}'
}
merge_verify 42 "$3"
`,
      "fixture-merge-admission",
      f.repo,
      f.incoming,
      JSON.stringify({
        replacementHead: "",
        autoMergeRequested: true,
        qualifiedRefusal: false,
        observation,
      }),
    ],
    { cwd: f.worktree, env: f.env, encoding: "utf8" },
  );
}

function gitFault(
  f: Pick<ReturnType<typeof fixture>, "env" | "repo" | "root" | "head">,
  phase: "before CAS" | "after CAS" | "race" | "lock race",
) {
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    env: f.env,
    encoding: "utf8",
  }).stdout.trim();
  const probe = join(f.root, "git-fault");
  writeFileSync(
    probe,
    `#!/usr/bin/env python3
import json,os,subprocess,sys,uuid
args=sys.argv[1:]
if args[-3:] == ['update-ref','--no-deref','--stdin']:
 data=sys.stdin.buffer.read()
 if ${JSON.stringify("update " + bindingRef + " ")}.encode() in data:
  if ${JSON.stringify(phase)} == 'lock race':
   git=[${JSON.stringify(realGit)},'-C',${JSON.stringify(f.repo)}]
   lock=${JSON.stringify(lockRef)}
   admitted=next(line.split()[2] for line in data.decode().splitlines() if line.startswith('verify '+lock+' '))
   assert subprocess.check_output([*git,'rev-parse',lock]).decode().strip() == admitted
   payload=subprocess.check_output([*git,'cat-file','blob',admitted]).decode()
   rows=payload.splitlines()
   assert len(rows) == 6 and rows[:2] == ['version=3','state=active']
   assert rows[-1].startswith('token=')
   rows[-1]='token='+str(uuid.uuid4())
   replacement=subprocess.check_output([*git,'hash-object','-w','--stdin'],input=('\\n'.join(rows)+'\\n').encode()).decode().strip()
   subprocess.check_call([*git,'update-ref','--no-deref',lock,replacement,admitted])
   result=subprocess.run([${JSON.stringify(realGit)},*args],input=data)
   open(${JSON.stringify(join(f.root, "fault-reached"))},'w').write(json.dumps({'admitted':admitted,'replacement':replacement,'transactionExit':result.returncode}))
   sys.exit(result.returncode)
  open(${JSON.stringify(join(f.root, "fault-reached"))},'w').write(${JSON.stringify(phase)})
  ${phase === "race" ? `subprocess.check_call([${JSON.stringify(realGit)},'-C',${JSON.stringify(f.repo)},'update-ref',${JSON.stringify(bindingRef)},${JSON.stringify(f.head)}])` : "pass"}
  ${phase === "after CAS" || phase === "race" ? `result=subprocess.run([${JSON.stringify(realGit)},*args],input=data); ${phase === "race" ? "sys.exit(result.returncode)" : "result.check_returncode()"}` : "pass"}
  sys.stderr.write('fixture ${phase} interruption\\n'); sys.exit(74)
 sys.exit(subprocess.run([${JSON.stringify(realGit)},*args],input=data).returncode)
os.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)},*args])
`,
    { mode: 0o700 },
  );
  return { OPENCLAW_PR_GIT: probe };
}

describePosix("correction-only workflow succession", () => {
  it.each([false, true])(
    "preserves signed correction and alias authority, baseline=%s",
    (baseline) => {
      const f = fixture(baseline);
      const previousArchives = new Set(readdirSync(join(f.worktree, ".local")));
      expectExit(f.transition(), 0);
      f.unchanged();
      f.expectAbsent("gates.env", "prepare-push-result.env", "prepare-sync-result.env");
      const next = f.git(f.repo, "rev-parse", bindingRef);
      const record = JSON.parse(f.git(f.repo, "show", `${next}:binding.json`));
      expect(record).toMatchObject({
        version: 2,
        predecessor: f.binding,
        source: f.current,
        continuation: { head: f.head, tree: f.tree, hostedHead: f.hosted, review: f.review },
      });
      expect(f.git(f.repo, "rev-parse", `${next}^@`).split("\n")).toEqual([
        f.binding,
        f.current,
        f.head,
        f.hosted,
      ]);
      const archives = readdirSync(join(f.worktree, ".local")).filter(
        (name) => name.startsWith("prep-evidence.") && !previousArchives.has(name),
      );
      expect(archives).toHaveLength(1);
      for (const name of previousArchives) {
        if (name.startsWith("prep-evidence.")) {
          expect(existsSync(f.local(name))).toBe(true);
        }
      }
      const [archive] = archives;
      expect(readFileSync(f.local(`${archive}/gates.env`)).equals(f.originalGate)).toBe(true);
      expect(readFileSync(f.local(`${archive}/prep.env`)).equals(f.readLocal("prep.env"))).toBe(
        true,
      );
      // These are the normal command owners, not a substitute gate checker.
      for (const command of ["prepare-push", "prepare-sync-head", "merge-verify"]) {
        const denied = f.run(command);
        expect(denied.status, denied.stdout + denied.stderr).not.toBe(0);
        expect(denied.stdout + denied.stderr).toContain("gates.env");
        expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.hosted);
      }
      f.unchanged();
      expectExit(f.run("prepare-gates"), 0);
      f.unchanged();
      const gates = f.readLocal("gates.env").toString();
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${f.hosted}\n`);
      expect(gates).not.toMatch(/VERIFIED|PASSED|FULL_GATES|REMOTE_GATES/u);
      expectExit(f.run("prepare-push"), 0);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.hosted);
      expect(f.prepGit("rev-parse", "HEAD")).toBe(f.head);
      expect(f.prepGit("hash-object", "--no-filters", f.local("correction-review.json"))).toBe(
        f.review,
      );
      expect(f.readLocal("prep.env").toString()).toContain(`LOCAL_PREP_HEAD_SHA=${f.head}\n`);
      expect(f.readLocal("prep.env").toString()).toContain(`PREP_HEAD_SHA=${f.hosted}\n`);
      expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(next);
      expectExit(verifyPublishedMerge(f), 0);
      expect(f.readLocal("merge-check-target").toString()).toBe(`${f.hosted}\n`);
      console.info("successor authority proof", {
        outcome: "allowed",
        baseline,
        predecessor: f.binding,
        successor: next,
        local: f.head,
        hosted: f.hosted,
        gateTarget: f.hosted,
        mergeChecksTarget: f.readLocal("merge-check-target").toString().trim(),
      });
    },
  );

  it("refuses the final binding write after admitted operation ownership is replaced", () => {
    const f = fixture();
    const previousArchives = new Set(readdirSync(join(f.worktree, ".local")));
    const result = f.transition(gitFault(f, "lock race"));
    const trace = JSON.parse(readFileSync(join(f.root, "fault-reached"), "utf8"));
    expect(trace.transactionExit).not.toBe(0);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(trace.replacement).not.toBe(trace.admitted);
    expect(f.git(f.repo, "rev-parse", lockRef)).toBe(trace.replacement);
    expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(f.binding);
    f.unchanged();
    f.expectAbsent("gates.env");
    const archives = readdirSync(join(f.worktree, ".local")).filter(
      (name) => name.startsWith("prep-evidence.") && !previousArchives.has(name),
    );
    expect(archives).toHaveLength(1);
    expect(readFileSync(f.local(`${archives[0]}/gates.env`)).equals(f.originalGate)).toBe(true);
    expect(readFileSync(f.local(`${archives[0]}/prep.env`)).equals(f.readLocal("prep.env"))).toBe(
      true,
    );
    console.info("successor authority proof", {
      outcome: "replaced-lock-refused",
      ...trace,
      wrapperExit: result.status,
      retainedBinding: f.git(f.repo, "rev-parse", bindingRef),
      retainedLock: f.git(f.repo, "rev-parse", lockRef),
    });
  });

  it.each([
    "binding",
    "from",
    "to",
    "head",
    "tree",
    "review",
    "hosted",
    "mode",
    "capture",
    "pending",
    "lock",
  ])("refuses %s drift before retiring qualification", (fault) => {
    const f = fixture();
    const overrides: Parameters<typeof f.args>[0] = {};
    const key = (
      {
        binding: "--expected-binding",
        from: "--from-workflow",
        to: "--to-workflow",
        head: "--expected-head",
        tree: "--expected-tree",
        review: "--expected-review",
        hosted: "--expected-hosted-head",
      } as Record<string, string>
    )[fault];
    if (key) {
      Object.assign(overrides, { [key]: f.incoming });
    }
    if (fault === "mode") {
      f.writeLocal(
        "prep-context.env",
        f
          .readLocal("prep-context.env")
          .toString()
          .replace("PREP_REVIEW_MODE=correction", "PREP_REVIEW_MODE=ready"),
      );
    }
    if (fault === "capture") {
      f.writeLocal("merge-output.log", "");
    }
    if (fault === "pending") {
      f.writeLocal("gates.env", "PENDING_CRABBOX_RUN_ID=123\n");
    }
    if (fault === "lock") {
      f.git(f.repo, "update-ref", lockRef, f.head);
    }
    const gate = f.readLocal("gates.env");
    const result = f.run("prepare-workflow-successor", f.args(overrides));
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(f.binding);
    expect(f.readLocal("gates.env").equals(gate)).toBe(true);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(f.head);
  });

  it.each(["before invalidation", "before CAS", "after CAS", "race"] as const)(
    "retains authority through %s interruption",
    (phase) => {
      const f = fixture();
      let extra: NodeJS.ProcessEnv;
      if (phase === "before invalidation") {
        const realRm = spawnSync("sh", ["-c", "command -v rm"], {
          env: f.env,
          encoding: "utf8",
        }).stdout.trim();
        writeFileSync(
          join(f.root, "bin/rm"),
          `#!/bin/sh\nif [ "$1" = .local/gates.env ]; then exit 74; fi\nexec '${realRm}' "$@"\n`,
          { mode: 0o700 },
        );
        extra = {};
      } else {
        extra = gitFault(f, phase);
      }
      const result = f.transition(extra);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      if (phase !== "before invalidation") {
        expect(readFileSync(join(f.root, "fault-reached"), "utf8")).toBe(phase);
      }
      f.unchanged();
      expect(existsSync(f.local("gates.env"))).toBe(phase === "before invalidation");
      const next = f.git(f.repo, "rev-parse", bindingRef);
      if (phase === "after CAS") {
        expect(JSON.parse(f.git(f.repo, "show", `${next}:binding.json`))).toMatchObject({
          predecessor: f.binding,
          source: f.current,
        });
      } else {
        expect(next).toBe(phase === "race" ? f.head : f.binding);
      }
      expect(
        readdirSync(join(f.worktree, ".local")).some((name) => name.startsWith("prep-evidence.")),
      ).toBe(true);
    },
  );

  it("rejects generic/current-workflow switches and duplicate selectors at the actual entrypoint", () => {
    const f = fixture();
    for (const args of [
      f.args().slice(0, -1),
      [...f.args(), "--current-workflow"],
      [...f.args().slice(0, -2), "--expected-head", f.head],
    ]) {
      expectExit(f.run("prepare-workflow-successor", args), 2);
    }
    expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(f.binding);
    f.unchanged();
  });
});

function proofFixture(successor = false, baseline = false, resolvedBlocker = false) {
  const f = createBaselineFixture(
    temps.make("pr-proof-publication-"),
    1,
    resolvedBlocker ? "BLOCKER" : "IMPORTANT",
  );
  if (baseline) {
    f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("proof baseline")));
    f.approve();
  }
  const binding = f.git(f.repo, "rev-parse", bindingRef);
  const source = JSON.parse(f.git(f.repo, "show", `${binding}:binding.json`)).source as string;
  const head = f.prepGit("rev-parse", "HEAD");
  const tree = f.prepGit("rev-parse", "HEAD^{tree}");
  let current = source;
  if (successor) {
    writeFileSync(join(f.repo, "workflow-version"), "proof publication owner\n");
    f.git(f.repo, "add", "workflow-version");
    f.git(f.repo, "commit", "-qm", "fix: proof publication fixture");
    current = f.git(f.repo, "rev-parse", "HEAD");
    f.git(f.repo, "config", `url.${f.repo}.insteadOf`, "https://github.com/openclaw/openclaw.git");
    f.git(f.repo, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    f.git(f.repo, "fetch", "-q", "origin", "main");
  }
  f.git(
    f.repo,
    "config",
    "--add",
    `url.${f.repo}.insteadOf`,
    "https://github.com/fixture/repo.git",
  );
  const review = JSON.parse(f.readLocal("correction-review.json").toString());
  review.recommendation = "NEEDS WORK";
  review.findings = [
    {
      id: resolvedBlocker ? "R2" : "I1",
      severity: "IMPORTANT",
      title: "Package proof is pending",
      area: "docs/fix-0.md",
      fix: "Observe the exact candidate through its published package.",
    },
  ];
  review.correction.resolvedFindings[0].resolution = resolvedBlocker
    ? "The blocking source defect was corrected and independently reviewed."
    : "";
  review.correction.proofPublication = {
    version: 1,
    kind: "published-candidate-proof",
    headSha: head,
    treeOid: tree,
    workflowSource: current,
    workflowBinding: binding,
    expectedHostedHead: f.incoming,
    pendingFindings: [
      {
        id: resolvedBlocker ? "R2" : "I1",
        evidence: "Retain a successful exact-package behavior receipt.",
      },
    ],
  };
  const writeReview = () => f.writeLocal("correction-review.json", JSON.stringify(review));
  writeReview();
  const reviewOid = () =>
    f.prepGit("hash-object", "--no-filters", f.local("correction-review.json"));
  const args = () =>
    Object.entries({
      "--expected-binding": binding,
      "--from-workflow": source,
      "--to-workflow": current,
      "--expected-head": head,
      "--expected-tree": tree,
      "--expected-review": reviewOid(),
      "--expected-hosted-head": f.incoming,
    }).flat();
  return {
    ...f,
    binding,
    source,
    current,
    head,
    tree,
    hosted: f.incoming,
    review,
    reviewOid,
    writeReview,
    args,
  };
}

describePosix("pending-proof correction publication", () => {
  it("permits a resolved historical BLOCKER while preserving the current proof finding", () => {
    const f = proofFixture(false, false, true);
    const before = f.snapshot([
      "review.json",
      "correction-review.json",
      "correction-incoming-review.json",
    ]);
    expectExit(f.run("prepare-publish-for-proof"), 0);
    f.expectSnapshot(before);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
    f.expectAbsent("prep.env", "gates.env");
    expect(f.readLocal("prepare-push-result.env").toString()).toContain(
      "PUSH_PENDING_FINDINGS=R2\n",
    );
  });
  it.each([false, true])(
    "publishes only the exact signed OID, baseline/successor=%s",
    (successor) => {
      const f = proofFixture(successor, successor);
      const before = f.snapshot([
        "review.json",
        "correction-review.json",
        "correction-incoming-review.json",
      ]);
      if (successor) {
        expectExit(f.run("prepare-workflow-successor", [...f.args(), "--for-proof"]), 0);
        expect(JSON.parse(f.git(f.repo, "show", `${bindingRef}:binding.json`))).toMatchObject({
          predecessor: f.binding,
          source: f.current,
          continuation: { head: f.head, tree: f.tree, review: f.reviewOid() },
        });
      }
      expectExit(f.run("prepare-publish-for-proof"), 0);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
      f.prepGit("verify-commit", f.head);
      f.expectSnapshot(before);
      f.expectAbsent("prep.env", "gates.env");
      const receipt = f.readLocal("prepare-push-result.env").toString();
      expect(receipt).toContain(`PUSH_PREP_HEAD_SHA=${f.head}\n`);
      expect(receipt).toContain(`PUSH_REVIEW_OID=${f.reviewOid()}\n`);
      expect(receipt).toContain("PUSH_PURPOSE=proof\n");
      expect(receipt).toContain("PUSH_PENDING_FINDINGS=I1\n");
      expectExit(f.run("prepare-publish-for-proof"), 0);
      expect(f.readLocal("prepare-push-result.env").toString()).toBe(receipt);
      // A forged gate stamp cannot turn a proof-only review into landing authority.
      expectExit(
        spawnSync(
          process.platform === "darwin" ? "/bin/bash" : "bash",
          [
            "-c",
            'source "$1"; write_gates_env_stamp 42 true false github_pending "" "" "$2" "" "" "" ""',
            "fixture-gates",
            join(f.repo, "scripts/pr-lib/gates.sh"),
            f.head,
          ],
          { cwd: f.worktree, env: f.env, encoding: "utf8" },
        ),
        0,
      );
      f.writeLocal(
        "prep.env",
        `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${f.incoming}\nPREP_HEAD_SHA=${f.head}\nLOCAL_PREP_HEAD_SHA=${f.head}\n`,
      );
      for (const command of [
        "prepare-gates",
        "prepare-push",
        "prepare-sync-head",
        "merge-verify",
      ]) {
        const denied = f.run(command);
        expect(denied.status, denied.stdout + denied.stderr).not.toBe(0);
        expect(denied.stdout + denied.stderr).toContain("READY");
        expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
      }
      f.expectSnapshot(before);
      f.review.recommendation = "READY FOR /prepare-pr";
      f.review.findings = [];
      f.review.correction.resolvedFindings[0].resolution =
        "Exact package proof completed and independently reviewed.";
      delete f.review.correction.proofPublication;
      f.writeReview();
      expectExit(f.run("prepare-gates"), 0);
      expectExit(f.run("prepare-push"), 0);
      expect(f.readLocal("prepare-push-result.env").toString()).toBe(receipt);
      expect(f.readLocal("prep.env").toString()).toContain(`PREP_HEAD_SHA=${f.head}\n`);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
    },
  );

  it.each(["ordinary receipt", "revised evidence", "pending finding"] as const)(
    "refreshes proof authority for an already published %s",
    (change) => {
      const f = proofFixture();
      expectExit(f.run("prepare-publish-for-proof"), 0);
      const original = f.readLocal("prepare-push-result.env").toString();
      const transport = original.replace(/^PUSH_(PURPOSE|REVIEW_OID|PENDING_FINDINGS)=.*\n/gm, "");
      if (change === "ordinary receipt") {
        f.writeLocal("prepare-push-result.env", transport);
      } else if (change === "revised evidence") {
        f.review.correction.proofPublication.pendingFindings[0].evidence +=
          " Include the operator-visible result.";
      } else {
        f.review.findings.push({ ...f.review.findings[0], id: "R2" });
        f.review.correction.proofPublication.pendingFindings.push({
          id: "R2",
          evidence: "Retain the separate package-bound observation.",
        });
      }
      f.writeReview();
      const review = f.readLocal("correction-review.json");
      const retainedReceipt = f.readLocal("prepare-push-result.env");
      // Invalid new authority must not consume or rewrite the prior receipt.
      if (change === "revised evidence") {
        f.review.correction.proofPublication.pendingFindings = [];
        f.writeReview();
        expectExit(f.run("prepare-publish-for-proof"), 1);
        expect(f.readLocal("prepare-push-result.env")).toEqual(retainedReceipt);
        f.writeLocal("correction-review.json", review);
        const mutation = join(f.root, "receipt-mutation");
        const marker = join(f.root, "receipt-mutation-reached");
        writeFileSync(
          mutation,
          `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('graphql')&&!fs.existsSync(${JSON.stringify(marker)})) {
 fs.appendFileSync(${JSON.stringify(f.local("prepare-push-result.env"))},'\\n');
 fs.writeFileSync(${JSON.stringify(marker)},'reached');
}
const result=cp.spawnSync(${JSON.stringify(f.env.OPENCLAW_GH_BIN)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
          { mode: 0o700 },
        );
        const refused = f.run("prepare-publish-for-proof", [], { OPENCLAW_GH_BIN: mutation });
        expectExit(refused, 1);
        expect(refused.stdout + refused.stderr).toContain("Correction review authority changed");
        expect(readFileSync(marker, "utf8")).toBe("reached");
        expect(f.readLocal("prepare-push-result.env").toString()).toBe(
          `${retainedReceipt.toString()}\n`,
        );
        f.writeLocal("prepare-push-result.env", retainedReceipt);
      }
      const realGit = spawnSync("sh", ["-c", "command -v git"], {
        env: f.env,
        encoding: "utf8",
      }).stdout.trim();
      const proxy = join(f.root, "no-publication");
      writeFileSync(
        proxy,
        `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('push')) { fs.writeFileSync(${JSON.stringify(join(f.root, "unexpected-push"))},'push'); process.exit(74); }
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      const result = f.run("prepare-publish-for-proof", [], { OPENCLAW_PR_GIT: proxy });
      expectExit(result, 0);
      expect(result.stdout).toContain("Remote branch already at local prep HEAD; skipping push.");
      expect(existsSync(join(f.root, "unexpected-push"))).toBe(false);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.head);
      expect(f.readLocal("correction-review.json")).toEqual(review);
      const receipt = f.readLocal("prepare-push-result.env").toString();
      expect(receipt.replace(/^PUSH_(PURPOSE|REVIEW_OID|PENDING_FINDINGS)=.*\n/gm, "")).toBe(
        transport,
      );
      expect(receipt).toContain("PUSH_PURPOSE=proof\n");
      expect(receipt).toContain(`PUSH_REVIEW_OID=${f.reviewOid()}\n`);
      expect(receipt).toContain(
        `PUSH_PENDING_FINDINGS=${change === "pending finding" ? "I1,R2" : "I1"}\n`,
      );
      f.expectAbsent("prep.env", "gates.env");
    },
  );

  it.each([
    "head",
    "tree",
    "workflow",
    "binding",
    "lease",
    "missing",
    "extra",
    "duplicate",
    "blocker",
    "hidden-incoming-blocker",
    "unlisted",
    "resolved-proof",
    "unvalidated",
    "incoming-review",
    "baseline",
    "branch",
  ])("refuses %s proof authority before publication", (fault) => {
    const f = proofFixture(false, fault === "baseline", fault === "hidden-incoming-blocker");
    const proof = f.review.correction.proofPublication;
    if (fault === "head") {
      proof.headSha = f.incoming;
    }
    if (fault === "tree") {
      proof.treeOid = f.incoming;
    }
    if (fault === "workflow") {
      proof.workflowSource = f.incoming;
    }
    if (fault === "binding") {
      proof.workflowBinding = f.incoming;
    }
    if (fault === "lease") {
      proof.expectedHostedHead = f.current;
    }
    if (fault === "missing") {
      proof.pendingFindings = [];
    }
    if (fault === "extra") {
      proof.pendingFindings.push({ id: "I2", evidence: "Unknown finding." });
    }
    if (fault === "duplicate") {
      proof.pendingFindings.push(proof.pendingFindings[0]);
    }
    if (fault === "blocker") {
      f.review.findings[0].severity = "BLOCKER";
    }
    if (fault === "hidden-incoming-blocker") {
      f.review.correction.resolvedFindings[0].resolution = "";
      f.review.findings[0].id = "I1";
      proof.pendingFindings[0].id = "I1";
    }
    if (fault === "unlisted") {
      f.review.findings.push({ ...f.review.findings[0], id: "I2" });
    }
    if (fault === "resolved-proof") {
      f.review.correction.resolvedFindings[0].resolution = "Contradicts the pending proof.";
    }
    if (fault === "unvalidated") {
      f.review.issueValidation.performed = false;
    }
    if (fault === "incoming-review") {
      f.writeLocal(
        "correction-incoming-review.json",
        f.readLocal("correction-incoming-review.json").toString() + "\n",
      );
    }
    if (fault === "baseline") {
      f.writeLocal("prepare-baseline.json", f.readLocal("prepare-baseline.json").toString() + "\n");
    }
    if (fault === "branch") {
      f.prepGit("switch", "-qc", "different-preparation-owner");
    }
    f.writeReview();
    const result = f.run("prepare-publish-for-proof");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.incoming);
    f.expectAbsent("prepare-push-result.env", "prep.env", "gates.env");
  });

  it.each([
    "auto",
    "queue",
    "unknown",
    "unknown-queue",
    "hosted-branch",
    "hosted-repository",
    "outcome",
    "capture",
    "graphql",
    "unsigned",
    "unsigned-commit",
    "alias",
  ])("refuses %s landing or transport authority without changing it", (fault) => {
    const f = proofFixture();
    const extra: NodeJS.ProcessEnv = {};
    if (["auto", "queue", "unknown", "unknown-queue"].includes(fault)) {
      mkdirSync(join(f.repo, ".local"), { recursive: true });
      const live: Record<string, unknown> = {
        id: "PR_fixture",
        number: 42,
        url: "https://github.com/fixture/repo/pull/42",
        state: "OPEN",
        headRefOid: f.incoming,
        baseRefName: "main",
        isDraft: false,
        mergeCommit: null,
        autoMergeRequest: fault === "auto" ? { mergeMethod: "SQUASH" } : null,
        isInMergeQueue: fault === "queue",
        isMergeQueueEnabled: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      };
      if (fault === "unknown") {
        delete live.autoMergeRequest;
      }
      if (fault === "unknown-queue") {
        delete live.isInMergeQueue;
      }
      writeFileSync(join(f.repo, ".local", "merge-live.json"), JSON.stringify(live));
    }
    if (fault === "hosted-branch" || fault === "hosted-repository") {
      mkdirSync(join(f.repo, ".local"), { recursive: true });
      writeFileSync(
        join(f.repo, ".local", "live.json"),
        JSON.stringify({
          head: {
            ref: fault === "hosted-branch" ? "other-topic" : "topic",
            sha: f.incoming,
            repo: {
              id: 1,
              node_id: "R_fixture",
              full_name: fault === "hosted-repository" ? "other/repo" : "fixture/repo",
              name: "repo",
              html_url: "https://github.com/fixture/repo",
              owner: { login: "fixture" },
            },
          },
        }),
      );
    }
    if (fault === "outcome") {
      f.git(f.repo, "update-ref", "refs/openclaw/pr-merge-outcomes/42", f.head);
    }
    if (fault === "capture") {
      f.writeLocal("merge-output.log", "retained merge attempt\n");
    }
    if (fault === "graphql") {
      extra.OPENCLAW_PR_PUSH_MODE = "graphql";
    }
    if (fault === "unsigned") {
      extra.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "1";
    }
    if (fault === "unsigned-commit") {
      f.prepGit(
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "Unsigned correction",
      );
      f.review.pr.headSha = f.prepGit("rev-parse", "HEAD");
      f.review.correction.proofPublication.headSha = f.review.pr.headSha;
      f.writeReview();
    }
    let hosted = f.incoming;
    if (fault === "alias") {
      hosted = f.prepGit("commit-tree", "-S", f.tree, "-p", f.incoming, "-m", "Same-tree alias");
      f.git(f.repo, "update-ref", "refs/heads/topic", hosted);
    }
    const result = f.run("prepare-publish-for-proof", [], extra);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(hosted);
    f.expectAbsent("prepare-push-result.env", "prep.env", "gates.env");
    if (fault === "outcome") {
      expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-merge-outcomes/42")).toBe(f.head);
    }
    if (fault === "capture") {
      expect(f.readLocal("merge-output.log").toString()).toContain("retained merge attempt");
    }
  });

  it.each(["permission", "lost response"])(
    "retains a %s without alternate publication",
    (fault) => {
      const f = proofFixture();
      const realGit = spawnSync("sh", ["-c", "command -v git"], {
        env: f.env,
        encoding: "utf8",
      }).stdout.trim();
      const proxy = join(f.root, "push-fault");
      writeFileSync(
        proxy,
        `#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
if 'push' in args:
 open(${JSON.stringify(join(f.root, "push-attempts"))},'a').write('push\\n')
 ${fault === "lost response" ? `subprocess.run([${JSON.stringify(realGit)},*args],check=True)` : "pass"}
 sys.stderr.write(${JSON.stringify(fault === "permission" ? "permission denied 403\n" : "response lost after accepted push\n")})
 sys.exit(74)
os.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)},*args])
`,
        { mode: 0o700 },
      );
      const result = f.run("prepare-publish-for-proof", [], { OPENCLAW_PR_GIT: proxy });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain("trying GraphQL");
      expect(readFileSync(join(f.root, "push-attempts"), "utf8")).toBe("push\n");
      f.expectAbsent("prepare-push-result.env", "prep.env", "gates.env");
      const observed = f.git(f.repo, "rev-parse", "topic");
      expect(observed).toBe(fault === "permission" ? f.incoming : f.head);
      if (fault === "lost response") {
        // Reconcile the independently observed exact OID; the failed invocation
        // never retries, and this explicit continuation must perform no write.
        expectExit(f.run("prepare-publish-for-proof", [], { OPENCLAW_PR_GIT: proxy }), 0);
        expect(readFileSync(join(f.root, "push-attempts"), "utf8")).toBe("push\n");
        expect(f.readLocal("prepare-push-result.env").toString()).toContain("PUSH_PURPOSE=proof\n");
      }
    },
  );

  it.each(
    ["review", "branch", "binding", "lock", "outcome", "capture"].flatMap((fault) =>
      [false, true].map((published) => ({ fault, published })),
    ),
  )(
    "refuses $fault mutation during the hosted read, published=$published",
    ({ fault, published }) => {
      const f = proofFixture();
      const proxy = join(f.root, "observation-fault");
      const realGit = spawnSync("sh", ["-c", "command -v git"], {
        env: f.env,
        encoding: "utf8",
      }).stdout.trim();
      const gitProxy = join(f.root, "publication-git");
      const marker = join(f.root, "observation-fault-reached");
      const attempts = join(f.root, "push-attempts");
      writeFileSync(
        gitProxy,
        `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('push')) fs.appendFileSync(${JSON.stringify(attempts)},'push\\n');
const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      writeFileSync(
        proxy,
        `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
const git=(args,input)=>cp.execFileSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(f.repo)},...args],{encoding:'utf8',input}).trim();
const published=git(['rev-parse','topic'])===${JSON.stringify(f.head)};
if(args.includes('graphql') && !fs.existsSync(${JSON.stringify(marker)}) && published===${published}) {
 const fault=${JSON.stringify(fault)}, record={fault,published};
 if(fault==='review') fs.appendFileSync(${JSON.stringify(f.local("correction-review.json"))},'\\n');
 if(fault==='branch') cp.execFileSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(f.worktree)},'switch','-qc','different-preparation-owner']);
 if(fault==='capture') fs.writeFileSync(${JSON.stringify(f.local("merge-output.log"))},'');
 if(fault==='outcome') git(['update-ref','refs/openclaw/pr-merge-outcomes/42',${JSON.stringify(f.head)}]);
 if(fault==='binding' || fault==='lock') {
  record.ref=fault==='binding'?${JSON.stringify(bindingRef)}:${JSON.stringify(lockRef)};
  record.admitted=git(['rev-parse',record.ref]);
  if(fault==='binding') {
   record.replacement=git(['commit-tree',git(['rev-parse',record.admitted+'^{tree}']),'-p',${JSON.stringify(f.source)},'-m','Replacement binding owner']);
  } else {
   const payload=git(['cat-file','blob',record.admitted]);
   if(!payload.startsWith('version=3\\nstate=active\\n')) throw new Error('Expected active lock');
   record.replacement=git(['hash-object','-w','--stdin'],payload.replace(/^token=.*$/m,'token='+require('node:crypto').randomUUID())+'\\n');
  }
  git(['update-ref','--no-deref',record.ref,record.replacement,record.admitted]);
 }
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(record));
}
const result=cp.spawnSync(${JSON.stringify(f.env.OPENCLAW_GH_BIN)},args,{stdio:'inherit'});
process.exit(result.status??1);
`,
        { mode: 0o700 },
      );
      const result = f.run("prepare-publish-for-proof", [], {
        OPENCLAW_GH_BIN: proxy,
        OPENCLAW_PR_GIT: gitProxy,
      });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      const trace = JSON.parse(readFileSync(marker, "utf8"));
      expect(trace).toMatchObject({ fault, published });
      if (fault === "review") {
        expect(result.stdout + result.stderr).toContain("Correction review authority changed");
      }
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(published ? f.head : f.incoming);
      if (published) {
        expect(readFileSync(attempts, "utf8")).toBe("push\n");
      } else {
        expect(existsSync(attempts)).toBe(false);
      }
      if (fault === "binding" || fault === "lock") {
        expect(trace.replacement).not.toBe(trace.admitted);
        expect(f.git(f.repo, "rev-parse", trace.ref)).toBe(trace.replacement);
      }
      if (fault === "outcome") {
        expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-merge-outcomes/42")).toBe(f.head);
      }
      if (fault === "capture") {
        expect(f.readLocal("merge-output.log").length).toBe(0);
      }
      f.expectAbsent("prepare-push-result.env", "prep.env", "gates.env");
    },
  );

  it.each(
    [false, true].flatMap((baseline) => [false, true].map((signed) => ({ baseline, signed }))),
  )(
    "reconciles an externally published correction range, baseline=$baseline, signed=$signed",
    ({ baseline, signed }) => {
      const f = proofFixture(false, baseline);
      f.prepGit(
        "-c",
        `commit.gpgsign=${signed}`,
        "commit",
        "--allow-empty",
        "-qm",
        "Intermediate correction",
      );
      f.prepGit("commit", "--allow-empty", "-qm", "Signed correction tip");
      const head = f.prepGit("rev-parse", "HEAD");
      f.prepGit("verify-commit", head);
      f.review.pr.headSha = head;
      f.review.correction.proofPublication.headSha = head;
      f.writeReview();
      f.git(f.repo, "update-ref", "refs/heads/topic", head);
      const before = f.snapshot([
        "review.json",
        "correction-review.json",
        "correction-incoming-review.json",
      ]);
      const result = f.run("prepare-publish-for-proof");
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expectExit(result, signed ? 0 : 1);
      f.expectSnapshot(before);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(head);
      f.expectAbsent("prep.env", "gates.env");
      if (signed) {
        expect(result.stdout).toContain("Remote branch already at local prep HEAD; skipping push.");
        const receipt = f.readLocal("prepare-push-result.env").toString();
        expect(receipt).toContain(`PUSHED_FROM_SHA=${f.incoming}\n`);
        expect(receipt).toContain(`PUSH_PREP_HEAD_SHA=${head}\n`);
        expect(receipt).toContain("PUSH_PURPOSE=proof\n");
      } else {
        expect(result.stderr).toContain("requires a signed correction range");
        expect(result.stderr).toContain(
          "its process group and every notification-pipe holder exited.",
        );
        f.expectAbsent("prepare-push-result.env");
      }
    },
  );

  it.each(["before CAS", "after CAS", "lock race"] as const)(
    "preserves pending proof through successor %s",
    (phase) => {
      const f = proofFixture(true);
      const before = f.snapshot([
        "review.json",
        "correction-review.json",
        "correction-incoming-review.json",
      ]);
      // The existing real-Git transaction fault owner applies to the same exact
      // binding/head tuple; proof admission does not get a second CAS path.
      const result = f.run(
        "prepare-workflow-successor",
        [...f.args(), "--for-proof"],
        gitFault(f, phase),
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expectExit(result, 1);
      // The injected fault must complete through the native drain owner; an
      // unrelated nonzero exit cannot prove the intended interruption boundary.
      expect(result.stderr).toContain(
        "its process group and every notification-pipe holder exited.",
      );
      const reached = readFileSync(join(f.root, "fault-reached"), "utf8");
      if (phase === "lock race") {
        const trace = JSON.parse(reached);
        expect(trace.transactionExit).toBeGreaterThan(0);
        expect(trace.replacement).not.toBe(trace.admitted);
        expect(f.git(f.repo, "rev-parse", lockRef)).toBe(trace.replacement);
      } else {
        expect(reached).toBe(phase);
        expect(result.stderr).toMatch(/^Git read failed$/m);
        expect(f.git(f.repo, "for-each-ref", "--format=%(refname)", lockRef)).toBe("");
      }
      f.expectSnapshot(before);
      expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.incoming);
      const next = f.git(f.repo, "rev-parse", bindingRef);
      if (phase === "after CAS") {
        expect(JSON.parse(f.git(f.repo, "show", `${next}:binding.json`))).toMatchObject({
          predecessor: f.binding,
          source: f.current,
        });
      } else {
        expect(next).toBe(f.binding);
      }
      f.expectAbsent("prepare-push-result.env", "prep.env", "gates.env");
    },
  );
});
