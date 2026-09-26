import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";
import { encodePackageActivationLauncher } from "./package-update-activation-journal.js";
import type { PackageActivationRecord } from "./package-update-activation-journal.js";

const [cut, root, encodedAuthority, encodedRecord] = process.argv.slice(2);
if (!cut || !root || !encodedAuthority) {
  throw new Error(
    "Package activation crash fixture requires its cut, root and original authority.",
  );
}
const authority: ReturnType<typeof captureUpdateCommandExecutorAuthority> =
  JSON.parse(encodedAuthority);
const replacement = cut.startsWith("replacement-");
const later = cut.startsWith("transition-") || replacement;
const expectedRecord: PackageActivationRecord | undefined = encodedRecord
  ? JSON.parse(encodedRecord)
  : undefined;
if (later && !expectedRecord) {
  throw new Error("A later journal cut requires the parent's exact expected record.");
}
let updated = false;
const interrupt = () => {
  fs.writeSync(1, `${JSON.stringify({ cut, pid: process.pid })}\n`);
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const isPrivateJournal = (file: string) =>
  file.startsWith(`${root}${path.sep}`) &&
  file.includes(`${path.sep}.activation-control-`) &&
  path.basename(file) === "operation.sqlite";
const open = fs.openSync.bind(fs);
fs.openSync = (file, flags, mode) => {
  const fd = open(file, flags, mode);
  if (cut === "created" && flags === "wx" && isPrivateJournal(String(file))) {
    interrupt();
  }
  return fd;
};
const isSelectedJournal = (file: string) =>
  later &&
  file.startsWith(`${root}${path.sep}`) &&
  file.endsWith(`${path.sep}operation.sqlite`) &&
  path.dirname(file).endsWith(".control");

// Capture native methods reflectively; each interception forwards its original receiver.
const prepare: DatabaseSync["prepare"] = Reflect.get(DatabaseSync.prototype, "prepare");
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (
    isPrivateJournal(this.location() ?? "") &&
    ((cut === "schema" && /^create table "package_activation"/iu.test(sql)) ||
      (cut === "inserted" && /^insert into "package_activation"/iu.test(sql)))
  ) {
    const originalRun: typeof statement.run = Reflect.get(statement, "run");
    statement.run = new Proxy(originalRun, {
      apply(run, receiver: unknown, args: unknown[]) {
        const result: unknown = Reflect.apply(run, receiver, args);
        interrupt();
        return result;
      },
    });
  }
  if (isSelectedJournal(this.location() ?? "") && /^update "package_activation" set /iu.test(sql)) {
    const originalRun: typeof statement.run = Reflect.get(statement, "run");
    statement.run = new Proxy(originalRun, {
      apply(run, receiver: unknown, args: unknown[]) {
        const result: unknown = Reflect.apply(run, receiver, args);
        assert(result !== null && typeof result === "object" && "changes" in result);
        assert(result.changes === 1 || result.changes === 1n, "Expected exactly one updated slot");
        updated = true;
        if (cut.endsWith("after-update")) {
          interrupt();
        }
        return result;
      },
    });
  }
  return statement;
};

const exec: DatabaseSync["exec"] = Reflect.get(DatabaseSync.prototype, "exec");
DatabaseSync.prototype.exec = function (sql) {
  const selectedCommit = updated && isSelectedJournal(this.location() ?? "") && sql === "COMMIT";
  if (selectedCommit && cut.endsWith("before-commit")) {
    interrupt();
  }
  exec.call(this, sql);
  if (selectedCommit && cut.endsWith("after-commit")) {
    interrupt();
  }
};
const rename = fs.renameSync.bind(fs);
fs.renameSync = (from, to) => {
  const publish =
    String(from).includes(`${path.sep}.activation-control-`) && String(to).endsWith(".control");
  if (publish && cut === "before-publication") {
    interrupt();
  }
  rename(from, to);
  if (publish && cut === "after-publication") {
    interrupt();
  }
};

const { withUpdateCommandExecutor } = await import("../cli/update-cli/update-command-executor.js");
const { withStateDatabaseCoordinatorRuntimeDirectory } =
  await import("./state-database-coordinator.js");
if (cut.startsWith("transition-")) {
  assert(expectedRecord);
  const { openPackageActivationJournal, resolvePackageActivationAnchor } =
    await import("./package-update-activation-journal.js");
  await withStateDatabaseCoordinatorRuntimeDirectory(path.dirname(authority.databasePath), () =>
    withUpdateCommandExecutor(
      randomUUID(),
      async (executor) => {
        const fence = await executor.enter(authority.installKey);
        const journal = openPackageActivationJournal(
          resolvePackageActivationAnchor(authority.installKey),
        );
        journal.transition(expectedRecord, "publishing", { kind: "displace" }, fence.assertCurrent);
      },
      { existingAuthority: authority },
    ),
  );
  throw new Error(`Package activation crash cut was not reached: ${cut}`);
}
const { preparePackageActivationJournal } = await import("./package-update-activation-prepare.js");
const { createPackageSwapFixture } = await import("./package-update-swap.test-support.js");
const { createPackageIntegrityReader } = await import("./package-update-integrity.js");
// A completed first operation has published its candidate. Keep that live root
// untouched; only the next operation's independently staged inputs are new.
const fixture = await createPackageSwapFixture(replacement ? path.join(root, "replacement") : root);
const liveRoot = replacement ? authority.installKey : fixture.packageRoot;
const launcher = replacement
  ? path.join(expectedRecord!.descriptor.binDir, "openclaw")
  : fixture.launcher;
await withStateDatabaseCoordinatorRuntimeDirectory(path.dirname(authority.databasePath), () =>
  withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(liveRoot);
      await preparePackageActivationJournal({
        options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
        liveRoot,
        stageRoot: fixture.params.stage.packageRoot,
        launcherRoot: fixture.params.stage.layout.binDir,
        binDir: path.dirname(launcher),
        previous: await createPackageIntegrityReader().tree(liveRoot),
        launchers: [
          {
            name: "openclaw",
            previous: encodePackageActivationLauncher(
              await createPackageIntegrityReader().launcher(launcher),
            ),
          },
        ],
      });
    },
    { existingAuthority: authority },
  ),
);
throw new Error(`Package activation crash cut was not reached: ${cut}`);
