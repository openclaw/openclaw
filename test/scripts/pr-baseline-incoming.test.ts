import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createBaselineFixture,
  failRestore,
  signBaselineRequest,
} from "./pr-baseline-native.test-support.js";
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
  expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
  expect(existsSync(f.local("correction-review.json"))).toBe(false);
  const history = readdirSync(f.local("."))
    .filter((name) => name.startsWith("prep-evidence."))
    .map((name) => join(f.local(name), "correction-review.json"))
    .find((path) => existsSync(path) && readFileSync(path).equals(historicalReview));
  expect(history).toBeDefined();
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
  it("integrates the signed incoming source while keeping its findings open until fresh review", () => {
    const f = fixture();
    const args = f.manifest(f.baseline);
    appendFileSync(f.local("review.json"), "\n");
    const stale = f.run("prepare-baseline-refresh", args);
    expect(stale.status, stale.stdout + stale.stderr).not.toBe(0);
    expectUnchanged(f);
    f.writeLocal("review.json", f.incomingReview);

    f.pass("prepare-baseline-refresh", args);
    const candidate = f.prepGit("rev-parse", "HEAD");
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
  });

  it("binds incoming authority across signing and resumes only the same installed candidate", () => {
    const f = fixture();
    const signer = f.prepGit("show", "-s", "--format=%GF", "HEAD");
    const requestArgs = [...f.manifest(f.baseline), "--signer", signer];
    const {
      signed: { target },
      args,
    } = signBaselineRequest(f, requestArgs);
    expectUnchanged(f);
    appendFileSync(f.local("review.json"), "\n");
    const changed = f.run("prepare-baseline-signing-continue", args);
    expect(changed.status, changed.stdout + changed.stderr).not.toBe(0);
    expect(changed.stderr).toContain("Incoming authority changed");
    expectUnchanged(f);
    f.writeLocal("review.json", f.incomingReview);
    const interrupted = f.run(
      "prepare-baseline-signing-continue",
      args,
      failRestore(f.root, f.env),
    );
    expect(interrupted.status, interrupted.stdout + interrupted.stderr).not.toBe(0);
    expect(JSON.parse(f.readLocal("review-transition.json").toString()).target).toBe(target);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(f.source);
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(target);
    f.expectReviews();
    f.pass("prepare-baseline-signing-continue", args);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(target);
    f.pass("prepare-correction-review-init");
    f.expectUnreviewed();
  });
});
