import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  const git = (...values: string[]) => f.prepGit(...values);
  const absent = (name: string) => expect(existsSync(f.local(name))).toBe(false);

  const assertRetainedSource = () => {
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(tree);
    expect(git("branch", "--show-current")).toBe("pr-42-prep");
    expect(readFileSync(join(f.worktree, f.product[0]!), "utf8")).toBe("later correction\n");
  };
  const assertOldAuthority = () => {
    assertRetainedSource();
    f.expectSnapshot(authority);
  };
  const rejected = (selected = args, env: NodeJS.ProcessEnv = {}) => {
    const result = f.run(command, selected, env);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    return result.stdout + result.stderr;
  };
  const replaceArgument = (name: string, value: string) =>
    args.map((item, index) => (args[index - 1] === name ? value : item));
  const oid = (name: string) => git("hash-object", "--no-filters", f.local(name));
  const read = (name: string) => f.readLocal(name);
  const write = (name: string, value: string | Buffer) => f.writeLocal(name, value);

  beforeAll(() => {
    f = createBaselineFixture(dirs.make("openclaw-pr-continuation-"), 1);
    // Publish through the real owner to a private Git remote. GitHub is the only
    // external adapter; the fixture does not manufacture publication receipts.
    incoming = f.publish();
    // A new signed fix follows the already published correction. The fresh
    // hosted review deliberately disagrees with the historical READY verdict.
    writeFileSync(join(f.worktree, f.product[0]!), "later correction\n");
    git("commit", "-qam", "fix: later correction");
    head = git("rev-parse", "HEAD");
    tree = git("rev-parse", "HEAD^{tree}");
    const review = validReview(incoming);
    review.issueValidation.status = "valid";
    review.findings.push({
      id: "I2",
      severity: "IMPORTANT",
      title: "Remaining behavior",
      area: f.product[0]!,
      fix: "Review the later correction",
    });
    write("review.json", JSON.stringify(review));
    write("pr-meta.json", JSON.stringify({ ...f.meta, headRefOid: incoming }));
    write("pr-meta.env", `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`);
    write("gates-build.log", "historical build proof\n");
    authority = f.snapshot([
      "prep-context.env",
      "prep.env",
      "gates.env",
      "correction-review.json",
      "correction-incoming-review.json",
      "prepare-push-result.env",
      "gates-build.log",
    ]);
    args = Object.entries({
      "expected-head": head,
      "expected-tree": tree,
      "incoming-head": incoming,
      "incoming-review": oid("review.json"),
      "publication-receipt": "push",
      "publication-oid": oid("prepare-push-result.env"),
    }).flatMap(([name, value]) => [`--${name}`, value]);
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
      write("prepare-push-result.env", replacement);
      expect(
        rejected(replaceArgument("--publication-oid", oid("prepare-push-result.env"))),
      ).toContain("does not match this preparation");
      write("prepare-push-result.env", receipt);
      assertOldAuthority();
    }
    const source = join(f.worktree, f.product[0]!);
    writeFileSync(source, "dirty correction\n");
    rejected();
    writeFileSync(source, "later correction\n");
    writeFileSync(join(f.worktree, "untracked.txt"), "uncommitted\n");
    rejected();
    unlinkSync(join(f.worktree, "untracked.txt"));
    git("switch", "-qc", "foreign-preparation");
    rejected();
    git("switch", "-q", "pr-42-prep");
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
    for (const [signed, parent, error] of [
      [false, incoming, "verify-commit"],
      [true, f.incoming, "refused rewritten history"],
    ] as const) {
      const replacement = git(
        ...(signed ? [] : ["-c", "commit.gpgSign=false"]),
        "commit-tree",
        tree,
        "-p",
        parent,
        ...(signed ? ["-S"] : []),
        "-m",
        "replacement",
      );
      git("update-ref", "refs/heads/pr-42-prep", replacement, head);
      expect(rejected(replaceArgument("--expected-head", replacement))).toContain(error);
      git("update-ref", "refs/heads/pr-42-prep", head, replacement);
    }
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
  for (const [effect, method, index, target, message] of [
    ['partial', 'unlinkSync', 0, '.local/gates.env', 'fixture interrupted metadata retirement'],
    ['installed', 'renameSync', 1, '.local/prep-context.env', 'fixture interrupted after context installation'],
  ]) {
    if (process.env.FIXTURE_EFFECT !== effect) continue;
    const original = fs[method];
    fs[method] = function(...args) {
      const result = original.apply(this, args);
      if (args[index] === target) throw new Error(message);
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
    absent("review-transition.json");
    assertOldAuthority();
    // Only the synthetic replacement ref belongs to this fixture cleanup.
    f.git(f.repo, "update-ref", "-d", "refs/openclaw/pr-operation-locks/42", foreign);
    const freshReview = read("review.json");
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "review-drift" })).toContain(
      "Incoming continuation authority changed",
    );
    write("review.json", freshReview);
    assertOldAuthority();
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "archive-drift" })).toContain(
      "Retained continuation evidence changed",
    );
    assertOldAuthority();
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "partial" })).toContain(
      "fixture interrupted metadata retirement",
    );
    assertRetainedSource();
    absent("gates.env");
    expect(read("prep-context.env")).toEqual(authority["prep-context.env"]);
    const journalBytes = read("review-transition.json");
    const journal = JSON.parse(journalBytes.toString());
    const archive = join(f.worktree, journal.continuation.archive);
    for (const [name, bytes] of Object.entries(authority)) {
      expect(readFileSync(join(archive, name))).toEqual(bytes);
    }
    const archivedContext = join(archive, "prep-context.env");
    writeFileSync(archivedContext, "changed recovery proof\n");
    expect(rejected()).toContain("Retained continuation evidence changed");
    writeFileSync(archivedContext, authority["prep-context.env"]!);
    expect(rejected(args, { ...extra, FIXTURE_EFFECT: "installed" })).toContain(
      "fixture interrupted after context installation",
    );
    assertRetainedSource();
    expect(read("review-transition.json")).toEqual(journalBytes);
    expect(readFileSync(f.local("prep-context.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE='${incoming}'`,
    );
    f.pass(command, args);
    assertRetainedSource();
    absent("review-transition.json");
    expect(read("review.json")).toEqual(freshReview);
    for (const name of [
      "prep.env",
      "gates.env",
      "correction-review.json",
      "prepare-push-result.env",
    ]) {
      absent(name);
    }
    // Historical hosted READY cannot admit the new candidate; a newly
    // initialized candidate review must resolve the fresh incoming finding.
    write("correction-review.json", authority["correction-review.json"]!);
    const staleReady = f.run("prepare-gates");
    expect(staleReady.status).not.toBe(0);
    expect(staleReady.stdout + staleReady.stderr).toMatch(/correction|review/iu);
  });
});
