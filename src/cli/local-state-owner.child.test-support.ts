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
    const [{ requireNodeSqlite }, { resolveGatewayLockPaths }] = await Promise.all([
      import("../infra/node-sqlite.js"),
      import("../infra/gateway-lock.js"),
    ]);
    const native = requireNodeSqlite();
    const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
    let worktreeSql = 0;
    let missingCustody = 0;
    const ownerPids = new Set<number>();
    const observe = (sql: string) => {
      if (!/\bworktrees?\b|\bworktree_/iu.test(sql)) {
        return;
      }
      worktreeSql += 1;
      try {
        const owner: { pid: number } = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        ownerPids.add(owner.pid);
      } catch {
        missingCustody += 1;
      }
    };
    for (const method of ["prepare", "exec"] as const) {
      Object.defineProperty(native.DatabaseSync.prototype, method, {
        ...Object.getOwnPropertyDescriptor(native.DatabaseSync.prototype, method),
        value: new Proxy(native.DatabaseSync.prototype[method], {
          apply(target, receiver, args: [string]) {
            observe(args[0]);
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
    }
    for (const method of ["get", "all", "run", "iterate"] as const) {
      Object.defineProperty(native.StatementSync.prototype, method, {
        ...Object.getOwnPropertyDescriptor(native.StatementSync.prototype, method),
        value: new Proxy(native.StatementSync.prototype[method], {
          apply(target, receiver: import("node:sqlite").StatementSync, args) {
            observe(receiver.sourceSQL);
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
    }
    process.on("exit", () => {
      fs.writeFileSync(
        path.join(control, "sql-observation.json"),
        JSON.stringify({
          pid: process.pid,
          worktreeSql,
          missingCustody,
          ownerPids: [...ownerPids],
        }),
      );
    });
    const [{ withConsoleLogsRoutedToStderrForJson }, { runCliWithExitFinalization }] =
      await Promise.all([import("./json-output-mode.js"), import("./one-shot-exit.js")]);
    await runCliWithExitFinalization({
      run: () =>
        withConsoleLogsRoutedToStderrForJson(
          process.argv,
          async () => {
            const program = new Command().name("openclaw").exitOverride();
            registerWorktreesCli(program);
            if (process.argv[2] === "sandbox") {
              const { registerSandboxCli } = await import("./sandbox-cli.js");
              registerSandboxCli(program);
            }
            await program.parseAsync(process.argv.slice(2), { from: "user" });
          },
          { retainRoutingUntilProcessExit: true },
        ),
      onError: (error) => {
        throw error;
      },
    });
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
