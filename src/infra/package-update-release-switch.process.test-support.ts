import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";

// Runs one package installation in a child and SIGKILLs it at a named point, or
// right after its Nth boundary (`boundary:N`). A boundary is one completed
// filesystem mutation, or the start or end of one exchange tool process.
// `complete` runs to the end. The layouts `linked` and `plain` switch releases;
// `swap` replaces a plain package directory in a prefix that keeps no releases
// and preserves its local dist files. `tools` set to `missing` makes every
// exchange tool fail to start. `verification` set to `fails` rejects the
// installed package and rolls the installation back.
const [cut, dir, layout, tools, verification] = process.argv.slice(2);
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
if (layout === "linked") {
  fixture.addRelease("r1", "2026.11.3", "build-old");
  fixture.linkTo("r1");
} else {
  fixture.writePlainPackage("2026.11.3", "build-old");
}
const params = await stagePackageRelease(
  fixture,
  "2026.12.1",
  "build-new",
  layout === "swap" ? path.join(fixture.globalRoot, ".openclaw.update-stage-fixture") : undefined,
);
fs.writeFileSync(path.join(dir, "candidate"), params.stage.packageRoot);

const symlink = fsp.symlink.bind(fsp);
fsp.symlink = async (target, file, type) => {
  interrupt(cut === "before-temporary-link" && temporary(file));
  await symlink(target, file, type);
  // Adoption prepares the package path's link inside the release it will name.
  interrupt(
    cut === "after-waiting-link" &&
      String(file).startsWith(path.join(fixture.prefix, "releases", path.sep)),
  );
};
const rename = fsp.rename.bind(fsp);
fsp.rename = async (from, to) => {
  const linkFlip = temporary(from) && String(to) === fixture.slot;
  interrupt(cut === "before-rename" && linkFlip);
  await rename(from, to);
  // Adoption installs a link to the previous release first; the cut targets the candidate.
  interrupt(
    cut === "after-rename" &&
      linkFlip &&
      fs.realpathSync(fixture.slot) === params.stage.packageRoot,
  );
};

let boundaries = 0;
const boundary = (label: string) => {
  boundaries += 1;
  fs.writeSync(1, `${JSON.stringify({ boundary: boundaries, label })}\n`);
  interrupt(cut === `boundary:${boundaries}`);
};
// Paths relative to the prefix, without the stamps that differ between runs.
const located = (value: unknown) =>
  (path.isAbsolute(String(value)) ? path.relative(fixture.prefix, String(value)) : String(value))
    .replace(/(releases\/[\d.]+)-[a-z\d]+-[a-f\d]{8}/u, "$1")
    .replace(/(\.openclaw\.release-link)-\d+-\d+-[a-f\d]{8}/u, "$1")
    .replace(/(\.openclaw\.package-backup)-\d+-\d+/u, "$1")
    .replace(/(shim-backup|shim-stage|local-overrides)-[A-Za-z\d]{6}/gu, "$1");
for (const name of [
  "mkdir",
  "mkdtemp",
  "symlink",
  "rename",
  "unlink",
  "rm",
  "utimes",
  "writeFile",
] as const) {
  const mutate = fsp[name] as (...args: unknown[]) => Promise<unknown>;
  Object.assign(fsp, {
    [name]: async (...args: unknown[]) => {
      const result = await mutate.apply(fsp, args);
      const paths = args.slice(0, name === "symlink" || name === "rename" ? 2 : 1);
      boundary(`${name} ${paths.map(located).join(" -> ")}`);
      return result;
    },
  });
}
type ToolCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = childProcess.execFile as unknown as (
  file: string,
  args: readonly string[],
  options: object,
  callback: ToolCallback,
) => unknown;
Object.assign(childProcess, {
  execFile: (file: string, args: readonly string[], options: object, callback: ToolCallback) => {
    const tool = path.basename(file);
    boundary(`start ${tool}`);
    if (tools === "missing") {
      const error = Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      return queueMicrotask(() => callback(error, "", ""));
    }
    return execFile(file, args, options, (...outcome) => {
      boundary(`end ${tool}`);
      callback(...outcome);
    });
  },
});
syncBuiltinESMExports();

// The transaction keeps retention with the update run, as `openclaw update` does.
let transaction: PackageUpdateTransaction | undefined;
const result = await swapStagedPackageInstall({
  ...params,
  assertCurrent: () => {},
  onTransaction: (issued) => {
    transaction = issued;
  },
  ...(layout === "swap"
    ? { localOverrides: { reapply: false, env: { OPENCLAW_STATE_DIR: path.join(dir, "state") } } }
    : {}),
  ...(verification === "fails"
    ? {
        postVerifyStep: async (root: string) => ({
          name: "post-install-verify",
          command: "verify installed package",
          cwd: root,
          durationMs: 0,
          exitCode: 1,
        }),
      }
    : {}),
});
assert.equal(cut, "complete", `Crash cut was not reached: ${cut} (${result.status})`);
// The update run owns a failed verification's rollback through the transaction.
const rollback = verification === "fails" ? await transaction?.rollback(() => {}) : undefined;
fs.writeSync(
  1,
  `${JSON.stringify({
    cut,
    status: result.status,
    detail: result.step.stdoutTail,
    rollback: rollback && { exitCode: rollback.exitCode, error: rollback.stderrTail },
  })}\n`,
);
