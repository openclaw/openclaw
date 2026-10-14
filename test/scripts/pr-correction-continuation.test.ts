import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const command = "prepare-correction-continue";

describePosix("published correction continuation through the canonical wrapper", () => {
  let f: ReturnType<typeof createBaselineFixture>;
  let incoming: string;
  let head: string;
  let tree: string;
  let args: string[];
  let authority: Record<string, Buffer>;

  const assertRetainedSource = () => {
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(f.git(f.worktree, "write-tree")).toBe(tree);
    expect(f.git(f.worktree, "branch", "--show-current")).toBe("pr-42-prep");
    expect(readFileSync(join(f.worktree, f.product[0]!), "utf8")).toBe("later correction\n");
  };
  const assertOldAuthority = () => {
    assertRetainedSource();
    for (const [name, bytes] of Object.entries(authority)) {
      expect(readFileSync(f.local(name)), name).toEqual(bytes);
    }
  };
  const rejected = (selected = args, env: NodeJS.ProcessEnv = {}) => {
    const result = f.run(command, selected, env);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    return result.stdout + result.stderr;
  };
  const replaceArgument = (name: string, value: string) =>
    args.map((item, index) => (args[index - 1] === name ? value : item));

  beforeAll(() => {
    f = createBaselineFixture(dirs.make("openclaw-pr-continuation-"), 1);
    // Publish through the real owner to a private Git remote. GitHub is the only
    // external adapter; the fixture does not manufacture publication receipts.
    incoming = f.publish();
    // A new signed fix follows the already published correction. The fresh
    // hosted review deliberately disagrees with the historical READY verdict.
    writeFileSync(join(f.worktree, f.product[0]!), "later correction\n");
    f.git(f.worktree, "commit", "-qam", "fix: later correction");
    head = f.git(f.worktree, "rev-parse", "HEAD");
    tree = f.git(f.worktree, "rev-parse", "HEAD^{tree}");
    const review = validReview(incoming);
    review.issueValidation.status = "valid";
    review.findings.push({
      id: "I2",
      severity: "IMPORTANT",
      title: "Remaining behavior",
      area: f.product[0]!,
      fix: "Review the later correction",
    });
    writeFileSync(f.local("review.json"), JSON.stringify(review));
    writeFileSync(f.local("pr-meta.json"), JSON.stringify({ ...f.meta, headRefOid: incoming }));
    writeFileSync(f.local("pr-meta.env"), `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`);
    writeFileSync(f.local("gates-build.log"), "historical build proof\n");
    authority = Object.fromEntries(
      [
        "prep-context.env",
        "prep.env",
        "gates.env",
        "correction-review.json",
        "correction-incoming-review.json",
        "prepare-push-result.env",
        "gates-build.log",
      ].map((name) => [name, readFileSync(f.local(name))]),
    );
    args = [
      "--expected-head",
      head,
      "--expected-tree",
      tree,
      "--incoming-head",
      incoming,
      "--incoming-review",
      f.git(f.worktree, "hash-object", "--no-filters", f.local("review.json")),
      "--publication-receipt",
      "push",
      "--publication-oid",
      f.git(f.worktree, "hash-object", "--no-filters", f.local("prepare-push-result.env")),
    ];
  });

  it("rejects stale selection, source and publication authority without replacing the preparation", () => {
    const oldRoute = f.run("prepare-correction-review-init");
    expect(oldRoute.status).not.toBe(0);
    expect(oldRoute.stderr + oldRoute.stdout).toContain("does not match the incoming PR review");
    for (const [name, error] of [
      ["--expected-head", "Continuation requires the selected clean preparation"],
      ["--expected-tree", "Continuation requires the selected clean preparation"],
      ["--incoming-review", "Incoming review changed"],
      ["--publication-oid", "Selected publication receipt changed"],
    ]) {
      expect(rejected(replaceArgument(name!, "a".repeat(40)))).toContain(error);
      assertOldAuthority();
    }
    const receipt = authority["prepare-push-result.env"]!;
    for (const replacement of [
      receipt
        .toString()
        .replace("PUSH_REPLACED_HOSTED_ANCESTRY=false", "PUSH_REPLACED_HOSTED_ANCESTRY=true"),
      receipt
        .toString()
        .replace(`PUSH_LOCAL_PREP_HEAD_SHA=${incoming}`, `PUSH_LOCAL_PREP_HEAD_SHA=${head}`),
    ]) {
      writeFileSync(f.local("prepare-push-result.env"), replacement);
      const oid = f.git(
        f.worktree,
        "hash-object",
        "--no-filters",
        f.local("prepare-push-result.env"),
      );
      expect(rejected(replaceArgument("--publication-oid", oid))).toContain(
        "does not match this preparation",
      );
      writeFileSync(f.local("prepare-push-result.env"), receipt);
      assertOldAuthority();
    }
    const source = join(f.worktree, f.product[0]!);
    writeFileSync(source, "dirty correction\n");
    rejected();
    writeFileSync(source, "later correction\n");
    writeFileSync(join(f.worktree, "untracked.txt"), "uncommitted\n");
    rejected();
    unlinkSync(join(f.worktree, "untracked.txt"));
    f.git(f.worktree, "switch", "-qc", "foreign-preparation");
    rejected();
    f.git(f.worktree, "switch", "-q", "pr-42-prep");
    const metaPath = f.local("pr-meta.json");
    const metaBytes = readFileSync(metaPath);
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(metaBytes.toString()), number: 43 }));
    expect(rejected()).toContain("43");
    writeFileSync(metaPath, metaBytes);
    assertOldAuthority();
  });

  it("refuses live PR drift and unsigned retained descendants", () => {
    mkdirSync(join(f.repo, ".local"), { recursive: true });
    const live = join(f.repo, ".local/live.json");
    for (const update of [
      { state: "closed" },
      { head: { ref: "foreign", sha: incoming, repo: { full_name: "fixture/repo" } } },
    ]) {
      writeFileSync(live, JSON.stringify(update));
      rejected();
      unlinkSync(live);
      assertOldAuthority();
    }
    const unsigned = f.git(
      f.worktree,
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
      "-p",
      incoming,
      "-m",
      "unsigned",
    );
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", unsigned, head);
    const output = rejected(replaceArgument("--expected-head", unsigned));
    expect(output).toContain("verify-commit");
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", head, unsigned);
    const unrelated = f.git(
      f.worktree,
      "commit-tree",
      tree,
      "-p",
      f.incoming,
      "-S",
      "-m",
      "unrelated signed correction",
    );
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", unrelated, head);
    expect(rejected(replaceArgument("--expected-head", unrelated))).toContain(
      "refused rewritten history",
    );
    f.git(f.worktree, "update-ref", "refs/heads/pr-42-prep", head, unrelated);
    assertOldAuthority();
  });

  it("revalidates authority after the live read, preserves partial retirement, and recovers only its exact journal", () => {
    // Inject I/O failures at real effects rather than adding a production seam.
    const hook = f.local("continuation-io.mjs");
    writeFileSync(
      hook,
      `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const phase = process.argv[1]?.endsWith('/correction-continuation.mjs') ? process.argv[2] : '';
const local = process.env.FIXTURE_WORKTREE + '/.local/';
if (phase === 'apply') {
  if (process.env.FIXTURE_EFFECT === 'lost-lock') {
    const run = (...args) => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
    const ref = 'refs/openclaw/pr-operation-locks/42';
    const old = run('rev-parse', ref);
    const foreign = cp.execFileSync('git', ['hash-object','-w','--stdin'], {input:'foreign owner\\n',encoding:'utf8'}).trim();
    run('update-ref', ref, foreign, old);
    fs.writeFileSync(local + 'foreign-lock', foreign);
  }
  if (process.env.FIXTURE_EFFECT === 'review-drift') fs.appendFileSync(local + 'review.json', '\\n');
  if (process.env.FIXTURE_EFFECT === 'archive-drift') {
    // The admitted directory is carried by the invocation's stdin facts.
    const read = fs.readFileSync;
    fs.readFileSync = function(path, ...rest) {
      const value = read.call(this, path, ...rest);
      if (path === 0) fs.appendFileSync(local + JSON.parse(value).request.archive.split('/').at(-1) + '/prep-context.env', '# changed\\n');
      return value;
    };
  }
  if (process.env.FIXTURE_EFFECT === 'partial') {
    const unlink = fs.unlinkSync;
    fs.unlinkSync = function(path) {
      const result = unlink.call(this, path);
      if (path === '.local/gates.env') throw new Error('fixture interrupted metadata retirement');
      return result;
    };
  }
  if (process.env.FIXTURE_EFFECT === 'installed') {
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = rename.call(this, from, to);
      if (to === '.local/prep-context.env') throw new Error('fixture interrupted after context installation');
      return result;
    };
  }
  syncBuiltinESMExports();
}
`,
    );
    const extra = { NODE_OPTIONS: `--import=${hook}`, FIXTURE_WORKTREE: f.worktree };
    rejected(args, { ...extra, FIXTURE_EFFECT: "lost-lock" });
    const foreign = readFileSync(f.local("foreign-lock"), "utf8");
    expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toBe(foreign);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    assertOldAuthority();
    // Only the synthetic replacement ref belongs to this fixture cleanup.
    f.git(f.repo, "update-ref", "-d", "refs/openclaw/pr-operation-locks/42", foreign);
    const freshReview = readFileSync(f.local("review.json"));
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "review-drift" })).toContain(
      "Incoming continuation authority changed",
    );
    writeFileSync(f.local("review.json"), freshReview);
    assertOldAuthority();
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "archive-drift" })).toContain(
      "Retained continuation evidence changed",
    );
    assertOldAuthority();
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "partial" })).toContain(
      "fixture interrupted metadata retirement",
    );
    assertRetainedSource();
    expect(existsSync(f.local("gates.env"))).toBe(false);
    expect(readFileSync(f.local("prep-context.env"))).toEqual(authority["prep-context.env"]);
    const journalBytes = readFileSync(f.local("review-transition.json"));
    const journal = JSON.parse(journalBytes.toString());
    const archive = join(f.worktree, journal.continuation.archive);
    for (const [name, bytes] of Object.entries(authority)) {
      expect(readFileSync(join(archive, name))).toEqual(bytes);
    }
    expect(rejected(replaceArgument("--expected-tree", "a".repeat(40)))).toContain(
      "Selected continuation differs",
    );
    expect(readFileSync(f.local("review-transition.json"))).toEqual(journalBytes);
    const archivedContext = join(archive, "prep-context.env");
    writeFileSync(archivedContext, "changed recovery proof\n");
    expect(rejected()).toContain("Retained continuation evidence changed");
    writeFileSync(archivedContext, authority["prep-context.env"]!);
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "installed" })).toContain(
      "fixture interrupted after context installation",
    );
    assertRetainedSource();
    expect(readFileSync(f.local("review-transition.json"))).toEqual(journalBytes);
    expect(readFileSync(f.local("prep-context.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE='${incoming}'`,
    );
    f.pass(command, args);
    assertRetainedSource();
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(readFileSync(f.local("review.json"))).toEqual(freshReview);
    for (const name of [
      "prep.env",
      "gates.env",
      "correction-review.json",
      "prepare-push-result.env",
    ]) {
      expect(existsSync(f.local(name)), name).toBe(false);
    }
    const context = readFileSync(f.local("prep-context.env"), "utf8");
    expect(context).toContain(`PR_HEAD_SHA_BEFORE='${incoming}'`);
    expect(context).not.toContain("PREP_BASELINE_REFRESH");
    // Historical hosted READY cannot admit the new candidate; a newly
    // initialized candidate review must resolve the fresh incoming finding.
    writeFileSync(f.local("correction-review.json"), authority["correction-review.json"]!);
    const staleReady = f.run("prepare-gates");
    expect(staleReady.status).not.toBe(0);
    expect(staleReady.stdout + staleReady.stderr).toMatch(/correction|review/iu);
    f.pass("prepare-correction-review-init");
    const candidate = JSON.parse(readFileSync(f.local("correction-review.json"), "utf8"));
    expect(candidate.pr.headSha).toBe(head);
    expect(candidate.recommendation).not.toBe("READY FOR /prepare-pr");
    expect(candidate.correction.resolvedFindings.map((item: { id: string }) => item.id)).toEqual([
      "I2",
    ]);
    expect(f.run("prepare-push").status).not.toBe(0);
    f.git(f.worktree, "verify-commit", "HEAD");
    expect(readdirSync(archive)).toContain("gates-build.log");
  });
});
