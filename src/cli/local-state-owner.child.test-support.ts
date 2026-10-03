import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import * as json5 from "json5";
import { registerSealedRuntime } from "../infra/sealed-runtime-registry.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { installCliSignalExitHandlers } from "./signal-exit-barrier.js";
import { registerWorktreesCli } from "./worktrees-cli.js";

const root = process.env.OPENCLAW_HOME!;
const control = path.join(root, "control");
fs.mkdirSync(control, { recursive: true });
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
installCliSignalExitHandlers();
try {
  if (process.argv[2] === "settlement") {
    const [
      { ManagedWorktreeService },
      { getOpenClawDatabaseMaintenanceScope },
      { openOpenClawStateDatabase },
    ] = await Promise.all([
      import("../agents/worktrees/service.js"),
      import("../state/openclaw-state-db-async-lifecycle.js"),
      import("../state/openclaw-state-db.js"),
    ]);
    const repoRoot = process.argv[3]!;
    let database: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    await runWithLocalStateOwner({
      method: "worktrees.create",
      params: { repoRoot, name: "settled" },
      target: repoRoot,
      runLocal: async ({ env, signal, assertCurrent }) => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        if (!scope) {
          throw new Error("Offline operation has no retained resource scope");
        }
        signal.addEventListener("abort", () => process.stdout.write("interrupted\n"));
        database = openOpenClawStateDatabase({ env });
        // This accepted continuation performs real Git/worker-backed registry work
        // after the command returns; root custody must cover it and native close.
        void scope.run(async () => {
          process.stdout.write(`pending:${scope.ownsSchemaMaintenance}\n`);
          await once(process.stdin, "data");
          await new ManagedWorktreeService({ env }).create({
            repoRoot,
            name: "settled",
            ownerKind: "manual",
            commitGuard: () => scope.assertOwnerCurrent(),
          });
        });
        assertCurrent();
      },
    });
    fs.writeFileSync(
      path.join(root, "settlement.json"),
      JSON.stringify({
        databaseOpen: database?.db.isOpen,
      }),
    );
  } else {
    const program = new Command().name("openclaw").exitOverride();
    registerWorktreesCli(program);
    await program.parseAsync(process.argv.slice(2), { from: "user" });
  }
} catch (error) {
  const [{ formatCliFailureLines, formatCliJsonFailure }, { isJsonOutputModeActive }] =
    await Promise.all([import("./failure-output.js"), import("./json-output-mode.js")]);
  if (isJsonOutputModeActive(process.argv)) {
    process.stdout.write(`${JSON.stringify(formatCliJsonFailure(error))}\n`);
  }
  for (const line of formatCliFailureLines({
    title: "The CLI command failed.",
    error,
    argv: process.argv,
  })) {
    process.stderr.write(`${line}\n`);
  }
  process.exitCode = 1;
} finally {
  process.stdin.pause();
}
