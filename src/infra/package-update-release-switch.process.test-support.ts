import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";

// Runs one package installation in a child and SIGKILLs it at a named point, or
// right after its Nth boundary (`boundary:N`). A boundary is one completed
// filesystem mutation, or the start or end of one exchange tool process.
// `complete` runs to the end. The layouts `linked` and `plain` switch releases;
// `swap` replaces a plain package directory in a prefix that keeps no releases
// and preserves its local dist files; `journal` publishes the same replacement
// through the publication journal, under the executor `authority` names, and
// also counts each journal commit and synchronous rename as a boundary. `tools`
// set to `missing` makes every exchange tool fail to start. `verification` set
// to `fails` rejects the installed package and rolls the installation back.
const [cut, dir, layout, tools, verification, authority] = process.argv.slice(2);
assert(cut && dir && layout, "Crash fixture requires cut, directory and layout");
const plainStage = layout === "swap" || layout === "journal";

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
  plainStage ? path.join(fixture.globalRoot, ".openclaw.update-stage-fixture") : undefined,
);
if (layout === "journal") {
  // The journal is prepared only for a candidate whose worker accepts delegated post-core work.
  const worker = path.join(
    params.stage.packageRoot,
    "dist/infra/update-migrated-finalize.worker.js",
  );
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(
    worker,
    'console.log(JSON.stringify({ postCoreExecutor: "stdin-pid-start-v1", mutationProtocol: "original-cancellation-v1" }));\n',
  );
}
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
    .replace(
      /(shim-backup|shim-stage|local-overrides|activation-anchor|activation-control)-[A-Za-z\d]{6}/gu,
      "$1",
    )
    .replace(/(\.openclaw\.package-activation)-[a-f\d]+/gu, "$1");
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
if (layout === "journal") {
  const renameSync = fs.renameSync.bind(fs);
  fs.renameSync = (from, to) => {
    renameSync(from, to);
    boundary(`renameSync ${located(from)} -> ${located(to)}`);
  };
  const exec: DatabaseSync["exec"] = Reflect.get(DatabaseSync.prototype, "exec");
  DatabaseSync.prototype.exec = function (sql) {
    exec.call(this, sql);
    if (sql === "COMMIT" && path.basename(this.location() ?? "") === "operation.sqlite") {
      boundary("journal commit");
    }
  };
}
syncBuiltinESMExports();

// The transaction keeps retention with the update run, as `openclaw update` does.
let transaction: PackageUpdateTransaction | undefined;
const install = async (
  activation?: Parameters<typeof swapStagedPackageInstall>[0]["activation"],
) => {
  const swapped = await swapStagedPackageInstall({
    ...params,
    assertCurrent: () => {},
    onTransaction: (issued) => {
      transaction = issued;
    },
    activation,
    ...(plainStage
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
  assert.equal(cut, "complete", `Crash cut was not reached: ${cut} (${swapped.status})`);
  // The update run owns a failed verification's rollback through the transaction,
  // while its executor still holds the installation.
  return {
    swapped,
    rollback: verification === "fails" ? await transaction?.rollback(() => {}) : undefined,
  };
};
const publishJournaled = async () => {
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const { packageActivationRuntimeForTest } =
    await import("./package-update-activation-runtime.test-support.js");
  return await withUpdateCommandExecutor(
    randomUUID(),
    async (executor) =>
      install({
        fence: await executor.enter(fixture.slot),
        runtime: packageActivationRuntimeForTest(),
        onPrepared: () => {},
      }),
    { existingAuthority: JSON.parse(authority!) },
  );
};
const { swapped: result, rollback } = await (authority ? publishJournaled() : install());
fs.writeSync(
  1,
  `${JSON.stringify({
    cut,
    status: result.status,
    detail: result.step.stdoutTail,
    rollback: rollback && { exitCode: rollback.exitCode, error: rollback.stderrTail },
  })}\n`,
);
