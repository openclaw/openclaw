import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture, signBaselineRequest } from "./pr-baseline-native.test-support.js";
import { reviewWithFinding } from "./pr-correction-preparation.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const f = createBaselineFixture(dirs.make("openclaw-pr-incoming-baseline-"), 1);
  const source = f.publish();
  const historicalReview = f.readLocal("correction-review.json");
  f.writeLocal("pr-meta.json", JSON.stringify({ ...f.meta, headRefOid: source }));
  f.writeLocal("pr-meta.env", f.readLocal("pr-meta.env").toString().replace(f.incoming, source));
  const review = reviewWithFinding(source, f.product[0]!, "I2");
  const incomingReview = Buffer.from(JSON.stringify(review));
  f.writeLocal("review.json", incomingReview);
  f.pass("prepare-correction-init");
  const history = readdirSync(f.local("."))
    .filter((name) => name.startsWith("prep-evidence."))
    .map((name) => join(f.local(name), "correction-review.json"))
    .find((path) => existsSync(path) && readFileSync(path).equals(historicalReview));
  const baseline = f.advanceMain("upstream repair");
  const expectReviews = () => {
    expect(f.readLocal("review.json")).toEqual(incomingReview);
    expect(readFileSync(history!)).toEqual(historicalReview);
  };
  const expectUnreviewed = () => {
    f.preparePublication();
    const result = f.run("prepare-push");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("The exact correction needs an independent READY review");
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(source);
  };
  return { ...f, source, baseline, incomingReview, expectReviews, expectUnreviewed };
}

function expectUnchanged(f: ReturnType<typeof fixture>) {
  expect(f.prepGit("rev-parse", "HEAD")).toBe(f.source);
  f.expectAbsent("prepare-baseline.json", "review-transition.json");
}

describePosix("first baseline integration from the reviewed incoming head", () => {
  it.each([false, true])(
    "binds incoming authority and requires fresh review (external signer=%s)",
    (externalSigner) => {
      const f = fixture();
      const manifest = f.manifest(f.baseline);
      const signed = externalSigner
        ? signBaselineRequest(f, [
            ...manifest,
            "--signer",
            f.prepGit("show", "-s", "--format=%GF", "HEAD"),
          ])
        : undefined;
      const command = signed ? "prepare-baseline-signing-continue" : "prepare-baseline-refresh";
      const args = signed?.args ?? manifest;
      expectUnchanged(f);
      appendFileSync(f.local("review.json"), "\n");
      const stale = f.run(command, args);
      expect(stale.status, stale.stdout + stale.stderr).not.toBe(0);
      if (signed) {
        expect(stale.stderr).toContain("Incoming authority changed");
      }
      expectUnchanged(f);
      f.writeLocal("review.json", f.incomingReview);

      f.pass(command, args);
      const candidate = f.prepGit("rev-parse", "HEAD");
      if (signed) {
        expect(candidate).toBe(signed.signed.target);
      }
      f.prepGit("verify-commit", candidate);
      expect(f.prepGit("show", "-s", "--format=%P", candidate)).toBe(`${f.source} ${f.baseline}`);
      expect(f.prepGit("show", `HEAD:${f.product[0]}`)).toBe(`resolved against ${f.baseline}`);
      f.expectReviews();
      expect(existsSync(f.local("correction-review.json"))).toBe(false);
      f.pass("prepare-correction-review-init");
      const correction = JSON.parse(f.readLocal("correction-review.json").toString()).correction;
      expect(correction.incomingHeadSha).toBe(f.source);
      expect(correction.resolvedFindings).toEqual([{ id: "I2", resolution: "" }]);
      f.expectUnreviewed();
      f.approve();
      expect(f.publish()).toBe(candidate);
    },
  );
});

function publicationFixture() {
  const f = createBaselineFixture(dirs.make("openclaw-pr-baseline-publication-"), 1);
  // The admitted main history is unsigned; only the task's commits need signatures.
  f.git(f.repo, "commit", "--allow-empty", "--no-gpg-sign", "-qm", "test: inherited main");
  const baseline = f.git(f.repo, "rev-parse", "HEAD");
  const parents = [baseline, f.incoming].flatMap((parent) => ["-p", parent]);
  const reconciled = f.prepGit("commit-tree", "-S", "HEAD^{tree}", ...parents, "-m", "fix: join");
  f.prepGit("reset", "--hard", reconciled);
  f.approve();
  f.pass("prepare-baseline-refresh", ["--expected-head", reconciled, "--baseline", baseline]);
  f.approve();
  return { ...f, baseline };
}

function expectRefused(f: ReturnType<typeof publicationFixture>) {
  const source = f.prepGit("rev-parse", "HEAD");
  f.preparePublication();
  const result = f.run("prepare-push");
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.incoming);
  expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
  expect(existsSync(f.local("prepare-push-result.env"))).toBe(false);
  return result;
}

describePosix("baseline-bound publication signatures", () => {
  it("publishes the signed correction without trusting inherited first-parent main history", () => {
    const f = publicationFixture();
    expect(
      spawnSync("git", ["verify-commit", f.baseline], { cwd: f.worktree, env: f.env }).status,
    ).not.toBe(0);
    expect(f.prepGit("rev-list", "--first-parent", `${f.incoming}..HEAD`)).toContain(f.baseline);
    const tree = f.prepGit("rev-parse", "HEAD^{tree}");
    const published = f.publish();
    expect(f.git(f.repo, "rev-parse", `${published}^{tree}`)).toBe(tree);
    expect(f.git(f.repo, "merge-base", f.incoming, published)).toBe(f.incoming);
  });

  it("rejects an unsigned task commit outside the first-parent chain", () => {
    const f = publicationFixture();
    f.prepGit("switch", "-qc", "unsigned-task", f.baseline);
    writeFileSync(join(f.worktree, "docs/later.md"), "later task change\n");
    f.prepGit("add", "docs/later.md");
    f.prepGit("commit", "--no-gpg-sign", "-qm", "fix: unsigned task change");
    const unsigned = f.prepGit("rev-parse", "HEAD");
    f.prepGit("switch", "-q", "pr-42-prep");
    f.prepGit("merge", "--no-ff", "-qm", "fix: merge the task change", unsigned);
    expect(f.prepGit("rev-list", "--first-parent", `${f.incoming}..HEAD`)).not.toContain(unsigned);
    f.approve();
    const result = expectRefused(f);
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "Refusing git-protocol PR branch push because it can publish unsigned commits.",
    );
  });

  it.each(["missing", "changed", "wrong-anchor", "unbound"])(
    "refuses %s baseline authority before either transport",
    (fault) => {
      const f = publicationFixture();
      if (fault === "missing") {
        rmSync(f.local("prepare-baseline.json"));
      } else if (fault === "changed") {
        const binding = JSON.parse(f.readLocal("prepare-baseline.json").toString());
        binding.baselineHead = f.incoming;
        f.writeLocal("prepare-baseline.json", JSON.stringify(binding));
      } else {
        const context = f.readLocal("prep-context.env").toString();
        f.writeLocal(
          "prep-context.env",
          fault === "wrong-anchor"
            ? context.replace(
                /^PREP_BASELINE_REFRESH_HEAD=.*$/mu,
                `PREP_BASELINE_REFRESH_HEAD=${f.incoming}`,
              )
            : context.replace(/^PREP_BASELINE_REFRESH_(?:HEAD|OID)=.*\n/gmu, ""),
        );
      }
      const result = expectRefused(f);
      expect(result.stderr).not.toContain("Pushing PR branch");
      expect(result.stderr).not.toContain("GraphQL push cannot preserve merge ancestry");
    },
  );
});
