import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Runs one release switch in a child and SIGKILLs it at a named point.
const [cut, dir, layout] = process.argv.slice(2);
assert(cut && dir && layout, "Crash fixture requires cut, directory and layout");

const temporary = (file: unknown) =>
  path.basename(String(file)).startsWith(".openclaw.release-link-");
const interrupt = (when: boolean) => {
  if (!when) {
    return;
  }
  fs.writeSync(1, `${JSON.stringify({ cut, pid: process.pid })}\n`);
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const { createPackageReleasePrefixFixture } =
  await import("./package-release-slot.test-support.js");
const { stagePackageRelease } = await import("./package-update-release-switch.test-support.js");
const { swapStagedPackageInstall } = await import("./package-update-swap.js");
const fixture = createPackageReleasePrefixFixture(dir);
if (layout === "plain") {
  fixture.writePlainPackage("2026.11.3", "build-old");
} else {
  fixture.addRelease("r1", "2026.11.3", "build-old");
  fixture.linkTo("r1");
}
const params = await stagePackageRelease(fixture, "2026.12.1", "build-new");
fs.writeFileSync(path.join(dir, "candidate"), params.stage.packageRoot);

const symlink = fsp.symlink.bind(fsp);
fsp.symlink = async (target, file, type) => {
  interrupt(cut === "before-temporary-link" && temporary(file));
  return await symlink(target, file, type);
};
const rename = fsp.rename.bind(fsp);
fsp.rename = async (from, to) => {
  const linkFlip = temporary(from) && String(to) === fixture.slot;
  // Adoption moves the package directory into releases/ before the link takes its place.
  const adoption = String(from) === fixture.slot;
  interrupt(cut === "before-rename" && linkFlip);
  await rename(from, to);
  interrupt(cut === "adoption-window" && adoption);
  // Adoption installs a link to the previous release first; the cut targets the candidate.
  interrupt(
    cut === "after-rename" &&
      linkFlip &&
      fs.realpathSync(fixture.slot) === params.stage.packageRoot,
  );
};

const result = await swapStagedPackageInstall({ ...params, assertCurrent: () => {} });
throw new Error(`Release switch crash cut was not reached: ${cut} (${result.status})`);
