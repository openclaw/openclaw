import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("prepared PR transport routing", () => {
  it("publishes an unsigned merge through Git with the existing manual opt-in", () => {
    const f = createBaselineFixture(dirs.make("openclaw-pr-push-routing-"), 1);
    f.git(f.repo, "commit", "--allow-empty", "--no-gpg-sign", "-qm", "test: side parent");
    const side = f.git(f.repo, "rev-parse", "HEAD");
    f.prepGit("merge", "--no-ff", "--no-gpg-sign", "-qm", "fix: merge reviewed history", side);
    const head = f.prepGit("rev-parse", "HEAD");
    expect(f.prepGit("show", "-s", "--format=%P", head).split(" ")).toHaveLength(2);
    f.writeLocal(
      "pr-meta.env",
      f.readLocal("pr-meta.env").toString() + "PR_HEAD_OWNER=fixture\nPR_HEAD_REPO_NAME=repo\n",
    );
    f.approve();
    f.preparePublication();
    const result = f.run("prepare-push", [], {
      OPENCLAW_PR_PUSH_MODE: "auto",
      OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH: "1",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(head);
    expect(f.readLocal("prepare-push-result.env").toString()).toContain(
      `PUSH_PREP_HEAD_SHA=${head}`,
    );
  });
});
