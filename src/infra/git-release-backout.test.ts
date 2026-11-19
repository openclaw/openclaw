import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listGitReleaseRoots,
  locateServingGitBuild,
  selectGitReleaseBackout,
} from "./git-release-backout.js";
import { writeGitReleaseBuild as writeBuild } from "./git-release-backout.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const serving = "a".repeat(40);
const neverServed = "b".repeat(40);

const release = (prefix: string, id: string) =>
  path.join(prefix, "releases", id, "lib", "node_modules", "openclaw");
const link = (id: string) => `../../releases/${id}/lib/node_modules/openclaw`;

async function fixture() {
  const prefix = await fs.realpath(dirs.make("git-release-backout-"));
  // The service still runs the developer checkout, which a conversion released as r0.
  const checkout = await writeBuild(path.join(prefix, "checkout"), serving, "serving-checkout");
  return { prefix, checkout };
}

it("locates the serving build by the build ID the Gateway reports, not by the release link", async () => {
  const { prefix, checkout } = await fixture();
  await writeBuild(release(prefix, "r1"), neverServed, "never-served");
  const roots = [checkout, ...(await listGitReleaseRoots(prefix))];
  await expect(locateServingGitBuild("serving-checkout", roots)).resolves.toEqual({
    root: checkout,
    commit: serving,
    version: "1.0.0",
  });
  await expect(locateServingGitBuild("not-installed", roots)).resolves.toBeUndefined();
});

it("keeps a fallback that is a release of the serving commit", async () => {
  const { prefix, checkout } = await fixture();
  await writeBuild(release(prefix, "r0"), serving, "serving-release");
  await expect(
    selectGitReleaseBackout({
      prefix,
      previous: link("r0"),
      serving: { root: checkout, commit: serving, version: "1.0.0" },
    }),
  ).resolves.toEqual({ kind: "keep" });
});

it("replaces a fallback that never served with the release of the serving commit", async () => {
  const { prefix, checkout } = await fixture();
  await writeBuild(release(prefix, "r0"), serving, "serving-release");
  await writeBuild(release(prefix, "r1"), neverServed, "never-served", "1.1.0");
  await expect(
    selectGitReleaseBackout({
      prefix,
      previous: link("r1"),
      serving: { root: checkout, commit: serving, version: "1.0.0" },
    }),
  ).resolves.toEqual({ kind: "replace", previous: link("r0"), releaseRoot: release(prefix, "r0") });
});

it.each([
  { case: "no release of the serving commit", damaged: false },
  { case: "only a damaged release of the serving commit", damaged: true },
])("finds no safe fallback with $case", async ({ damaged }) => {
  const { prefix, checkout } = await fixture();
  await writeBuild(release(prefix, "r1"), neverServed, "never-served", "1.1.0");
  if (damaged) {
    const root = await writeBuild(release(prefix, "r0"), serving, "serving-release");
    await fs.rm(path.join(root, "dist", "entry.js"));
  }
  await expect(
    selectGitReleaseBackout({
      prefix,
      previous: link("r1"),
      serving: { root: checkout, commit: serving, version: "1.0.0" },
    }),
  ).resolves.toEqual({ kind: "none" });
});
