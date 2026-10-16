import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const f = createBaselineFixture(dirs.make("openclaw-pr-incoming-baseline-"), 1);
  const source = f.publish();
  const historicalReview = readFileSync(f.local("correction-review.json"));
  writeFileSync(f.local("pr-meta.json"), JSON.stringify({ ...f.meta, headRefOid: source }));
  writeFileSync(
    f.local("pr-meta.env"),
    readFileSync(f.local("pr-meta.env"), "utf8").replace(f.incoming, source),
  );
  const review = validReview(source);
  review.recommendation = "NEEDS WORK";
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I2",
    severity: "IMPORTANT",
    title: "Integrate the upstream repair",
    area: f.product[0]!,
    fix: "Resolve the current baseline conflict",
  });
  const incomingReview = Buffer.from(JSON.stringify(review));
  writeFileSync(f.local("review.json"), incomingReview);
  f.pass("prepare-correction-init");
  expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(source);
  expect(existsSync(f.local("correction-review.json"))).toBe(false);
  const history = readdirSync(f.local("."))
    .filter((name) => name.startsWith("prep-evidence."))
    .map((name) => join(f.local(name), "correction-review.json"))
    .find((path) => existsSync(path) && readFileSync(path).equals(historicalReview));
  expect(history).toBeDefined();
  const baseline = f.advanceMain("upstream repair");
  return { ...f, source, baseline, incomingReview, historicalReview, history: history! };
}

function expectUnchanged(f: ReturnType<typeof fixture>) {
  expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.source);
  expect(existsSync(f.local("prepare-baseline.json"))).toBe(false);
  expect(existsSync(f.local("review-transition.json"))).toBe(false);
}

describePosix("first baseline integration from the reviewed incoming head", () => {
  it("integrates the signed incoming source while keeping its findings open until fresh review", () => {
    const f = fixture();
    const args = f.manifest(f.baseline);
    appendFileSync(f.local("review.json"), "\n");
    const stale = f.run("prepare-baseline-refresh", args);
    expect(stale.status, stale.stdout + stale.stderr).not.toBe(0);
    expectUnchanged(f);
    writeFileSync(f.local("review.json"), f.incomingReview);

    f.pass("prepare-baseline-refresh", args);
    const candidate = f.git(f.worktree, "rev-parse", "HEAD");
    f.git(f.worktree, "verify-commit", candidate);
    expect(f.git(f.worktree, "show", "-s", "--format=%P", candidate)).toBe(
      `${f.source} ${f.baseline}`,
    );
    expect(f.git(f.worktree, "show", `HEAD:${f.product[0]}`)).toBe(
      `resolved against ${f.baseline}`,
    );
    expect(readFileSync(f.local("review.json"))).toEqual(f.incomingReview);
    expect(readFileSync(f.history)).toEqual(f.historicalReview);
    expect(existsSync(f.local("correction-review.json"))).toBe(false);
    f.pass("prepare-correction-review-init");
    const correction = JSON.parse(readFileSync(f.local("correction-review.json"), "utf8"));
    expect(correction.correction.incomingHeadSha).toBe(f.source);
    expect(correction.correction.resolvedFindings).toEqual([{ id: "I2", resolution: "" }]);
    f.preparePublication();
    const unreviewed = f.run("prepare-push");
    expect(unreviewed.status, unreviewed.stdout + unreviewed.stderr).not.toBe(0);
    expect(unreviewed.stderr).toContain("The exact correction needs an independent READY review");
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.source);
    f.approve();
    expect(f.publish()).toBe(candidate);
  });

  it("binds incoming authority across signing and resumes only the same installed candidate", () => {
    const f = fixture();
    const signer = f.git(f.worktree, "show", "-s", "--format=%GF", "HEAD");
    const requestArgs = [...f.manifest(f.baseline), "--signer", signer];
    const pending = f.pass("prepare-baseline-signing-request", requestArgs);
    const oid = /Awaiting signature: request=([a-f0-9]{40})/u.exec(pending.stdout)![1]!;
    const request = JSON.parse(
      readFileSync(f.local(`prepare-baseline-signing.${oid}.json`), "utf8"),
    );
    expectUnchanged(f);
    const unsigned = Buffer.from(request.unsignedCommit, "base64");
    const separator = unsigned.indexOf("\n\n");
    const headers = unsigned.subarray(0, separator).toString();
    const tree = /^tree ([a-f0-9]{40})$/mu.exec(headers)![1]!;
    const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((match) => match[1]!);
    const identity: NodeJS.ProcessEnv = {};
    for (const role of ["author", "committer"]) {
      const [, name, email, date] = new RegExp(`^${role} (.*) <([^>]*)> (.*)$`, "mu").exec(
        headers,
      )!;
      identity[`GIT_${role.toUpperCase()}_NAME`] = name;
      identity[`GIT_${role.toUpperCase()}_EMAIL`] = email;
      identity[`GIT_${role.toUpperCase()}_DATE`] = date;
    }
    const signed = spawnSync(
      "git",
      ["commit-tree", "-S", tree, ...parents.flatMap((parent) => ["-p", parent])],
      {
        cwd: f.worktree,
        env: { ...f.env, ...identity },
        input: unsigned.subarray(separator + 2),
        encoding: "utf8",
      },
    );
    expect(signed.status, signed.stderr).toBe(0);
    const target = signed.stdout.trim();
    const commit = spawnSync("git", ["cat-file", "commit", target], {
      cwd: f.worktree,
      env: f.env,
    });
    expect(commit.status, commit.stderr.toString()).toBe(0);
    const response = f.local("signed-commit");
    writeFileSync(response, commit.stdout);
    const args = ["--request", oid, "--signed-commit", response];
    appendFileSync(f.local("review.json"), "\n");
    const changed = f.run("prepare-baseline-signing-continue", args);
    expect(changed.status, changed.stdout + changed.stderr).not.toBe(0);
    expect(changed.stderr).toContain("Incoming authority changed");
    expectUnchanged(f);
    writeFileSync(f.local("review.json"), f.incomingReview);
    const failRestore = join(f.root, "fail-restore");
    const realGit = spawnSync("sh", ["-c", "command -v git"], {
      env: f.env,
      encoding: "utf8",
    }).stdout.trim();
    writeFileSync(
      failRestore,
      `#!/bin/bash
if [ "$1" = --literal-pathspecs ] && [ "$2" = restore ]; then exit 72; fi
exec '${realGit}' "$@"
`,
      { mode: 0o755 },
    );
    const interrupted = f.run("prepare-baseline-signing-continue", args, {
      OPENCLAW_PR_GIT: failRestore,
    });
    expect(interrupted.status, interrupted.stdout + interrupted.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(f.local("review-transition.json"), "utf8")).target).toBe(target);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.source);
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(target);
    expect(readFileSync(f.local("review.json"))).toEqual(f.incomingReview);
    expect(readFileSync(f.history)).toEqual(f.historicalReview);
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(target);
    f.pass("prepare-correction-review-init");
    f.preparePublication();
    const unreviewed = f.run("prepare-push");
    expect(unreviewed.status, unreviewed.stdout + unreviewed.stderr).not.toBe(0);
    expect(unreviewed.stderr).toContain("The exact correction needs an independent READY review");
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.source);
  });
});
