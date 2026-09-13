import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor.js";

const [cut, root, encodedAuthority] = process.argv.slice(2);
if (!cut || !root || !encodedAuthority) {
  throw new Error(
    "Package activation crash fixture requires its cut, root and original authority.",
  );
}
const authority: ReturnType<typeof captureUpdateCommandExecutorAuthority> =
  JSON.parse(encodedAuthority);
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
// oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted database receiver.
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (
    isPrivateJournal(this.location() ?? "") &&
    ((cut === "schema" && /^create table "package_activation"/iu.test(sql)) ||
      (cut === "inserted" && /^insert into "package_activation"/iu.test(sql)))
  ) {
    // oxlint-disable-next-line typescript/unbound-method -- the proxy preserves overloads and forwards the original receiver.
    statement.run = new Proxy(statement.run, {
      apply(run, receiver: unknown, args: unknown[]) {
        const result: unknown = Reflect.apply(run, receiver, args);
        interrupt();
        return result;
      },
    });
  }
  return statement;
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
const { preparePackageActivationJournal } = await import("./package-update-activation-prepare.js");
const { createPackageSwapFixture } = await import("./package-update-swap.test-support.js");
const { createPackageIntegrityReader } = await import("./package-update-integrity.js");
const fixture = await createPackageSwapFixture(root);
await withUpdateCommandExecutor(
  randomUUID(),
  async (executor) => {
    const fence = await executor.enter(fixture.packageRoot);
    await preparePackageActivationJournal({
      options: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
      liveRoot: fixture.packageRoot,
      stageRoot: fixture.params.stage.packageRoot,
      launcherRoot: fixture.params.stage.layout.binDir,
      binDir: path.dirname(fixture.launcher),
      previous: await createPackageIntegrityReader().tree(fixture.packageRoot),
      launchers: [
        {
          name: "openclaw",
          previous: await createPackageIntegrityReader().launcher(fixture.launcher),
        },
      ],
    });
  },
  { existingAuthority: authority },
);
throw new Error(`Package activation crash cut was not reached: ${cut}`);
