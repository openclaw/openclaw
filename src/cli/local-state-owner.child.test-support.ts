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
const writeJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const writeJsonFile = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value));
const registrations: Record<string, () => Promise<(program: Command) => void>> = {
  sandbox: async () => (await import("./sandbox-cli.js")).registerSandboxCli,
  agents: async () => (await import("./program/register.agent.js")).registerAgentsCommands,
  setup: async () => (await import("./program/register.setup.js")).registerSetupCommand,
  onboard: async () => (await import("./program/register.onboard.js")).registerOnboardCommand,
  config: async () => (await import("./config-cli.js")).registerConfigCli,
  migrate: async () => (await import("./program/register.migrate.js")).registerMigrateCommand,
  mcp: async () => (await import("./mcp-cli.js")).registerMcpCli,
  models: async () => (await import("./models-cli.js")).registerModelsCli,
  "exec-policy": async () => (await import("./exec-policy-cli.js")).registerExecPolicyCli,
  database: async () => (await import("./program/register.database.js")).registerDatabaseCommand,
};
try {
  if (process.argv[2] === "migrate-uncertain") {
    const { runMigrationApply } = await import("../commands/migrate/apply.js");
    const { hasCommandProcessCleanupError } = await import("../process/exec-result.js");
    const { retainCommandProcessCleanup } = await import("../process/exec-spawn.js");
    const { resolveGatewayLockPaths, readLockPayloadSync } =
      await import("../infra/gateway-lock.js");
    const { summarizeMigrationItems } = await import("../plugin-sdk/migration.js");
    const plan = {
      providerId: "fixture",
      source: "synthetic-source",
      summary: summarizeMigrationItems([]),
      items: [],
    };
    let applyCompleted = false;
    const failure = await runMigrationApply({
      runtime: {
        log() {},
        error() {},
        exit(code) {
          throw new Error(`unexpected exit ${code}`);
        },
      },
      opts: { json: true, noBackup: true, configOverride: {} },
      providerId: "fixture",
      provider: {
        id: "fixture",
        label: "Fixture",
        plan: async () => plan,
        apply: async () => {
          retainCommandProcessCleanup(Promise.resolve("uncertain"));
          return plan;
        },
      },
      onApplyCompleted: () => {
        applyCompleted = true;
      },
    }).catch((error: unknown) => error);
    let laterMutationRan = false;
    const laterRefused = await runWithLocalStateOwner({
      method: "migrate.apply",
      params: {},
      target: "later mutation",
      onForeignOwner: "refuse",
      runLocal: async () => {
        laterMutationRan = true;
      },
    }).then(
      () => false,
      () => true,
    );
    const owner = readLockPayloadSync(resolveGatewayLockPaths(process.env).ownerLockPath);
    writeJson({
      applyCompleted,
      uncertain: hasCommandProcessCleanupError(failure),
      ownsState: owner?.pid === process.pid,
      laterMutationRan,
      laterRefused,
    });
  } else if (process.argv[2] === "settlement") {
    const { ManagedWorktreeService } = await import("../agents/worktrees/service.js");
    const { getOpenClawDatabaseMaintenanceScope } =
      await import("../state/openclaw-state-db-async-lifecycle.js");
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const repoRoot = process.argv[3]!;
    let database: ReturnType<typeof openOpenClawStateDatabase> | undefined;
    await runWithLocalStateOwner({
      method: "worktrees.create",
      params: { repoRoot, name: "settled" },
      target: repoRoot,
      runLocal: async ({ env, config, signal, assertCurrent }) => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        if (!scope) {
          throw new Error("Offline operation has no retained resource scope");
        }
        signal.addEventListener("abort", () => process.stdout.write("interrupted\n"));
        database = openOpenClawStateDatabase({ env });
        // Accepted work outlives the command; custody must cover it and native close.
        void scope.run(async () => {
          process.stdout.write(`pending:${scope.ownsSchemaMaintenance}\n`);
          await once(process.stdin, "data");
          await new ManagedWorktreeService({ env, getConfig: () => config }).create({
            repoRoot,
            name: "settled",
            ownerKind: "manual",
            commitGuard: () => scope.assertOwnerCurrent(),
          });
        });
        assertCurrent();
      },
    });
    writeJsonFile(path.join(root, "settlement.json"), { databaseOpen: database?.db.isOpen });
  } else {
    const { requireNodeSqlite } = await import("../infra/node-sqlite.js");
    const { resolveGatewayLockPaths } = await import("../infra/gateway-lock.js");
    const native = requireNodeSqlite();
    const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
    let worktreeSql = 0;
    let missingCustody = 0;
    const ownerPids = new Set<number>();
    const ownershipWrites: Array<{ pid?: number; role?: string }> = [];
    const observe = (sql: string, executing = true) => {
      const worktree = /\bworktrees?\b|\bworktree_/iu.test(sql);
      const ownershipWrite =
        executing && /\binsert\s+into\b/iu.test(sql) && /\bconfig_machine_state\b/iu.test(sql);
      if (!worktree && !ownershipWrite) {
        return;
      }
      worktreeSql += Number(worktree);
      let identity: { pid?: number; role?: string } = {};
      try {
        const owner: { pid: number; role?: string } = JSON.parse(
          fs.readFileSync(ownerPath, "utf8"),
        );
        if (worktree) {
          ownerPids.add(owner.pid);
        }
        identity = { pid: owner.pid, role: owner.role };
      } catch {
        missingCustody += Number(worktree);
      }
      if (ownershipWrite) {
        ownershipWrites.push(identity);
      }
    };
    for (const method of ["prepare", "exec"] as const) {
      Object.defineProperty(native.DatabaseSync.prototype, method, {
        ...Object.getOwnPropertyDescriptor(native.DatabaseSync.prototype, method),
        value: new Proxy(native.DatabaseSync.prototype[method], {
          apply(target, receiver, args: [string]) {
            observe(args[0], method === "exec");
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
      writeJsonFile(path.join(control, "sql-observation.json"), {
        pid: process.pid,
        worktreeSql,
        missingCustody,
        ownerPids: [...ownerPids],
        ownershipWrites,
      });
    });
    const { withConsoleLogsRoutedToStderrForJson } = await import("./json-output-mode.js");
    const { runCliWithExitFinalization } = await import("./one-shot-exit.js");
    const runCommand = async () => {
      if (process.argv[2] === "config-unset-route") {
        const { tryRouteCli } = await import("./route.js");
        const routed = await tryRouteCli([
          ...process.argv.slice(0, 2),
          "config",
          "unset",
          ...process.argv.slice(3),
        ]);
        if (!routed) {
          throw new Error("Config unset route was not selected");
        }
      } else if (process.argv[2] === "ownership-claim-direct") {
        const { claimOpenClawStateOwnership } =
          await import("../state/openclaw-state-ownership-operations.js");
        writeJson({ ownership: claimOpenClawStateOwnership("supervisor") });
      } else {
        const program = new Command().name("openclaw").exitOverride();
        registerWorktreesCli(program);
        const command = process.argv[2]!;
        const register = await registrations[command]?.();
        if (["agents", "setup", "onboard", "config"].includes(command)) {
          const { registerPreActionHooks } = await import("./program/preaction.js");
          registerPreActionHooks(program, "test");
        }
        register?.(program);
        await program.parseAsync(process.argv.slice(2), { from: "user" });
      }
    };
    await runCliWithExitFinalization({
      run: () =>
        withConsoleLogsRoutedToStderrForJson(process.argv, runCommand, {
          retainRoutingUntilProcessExit: true,
        }),
      onError: (error) => {
        throw error;
      },
    });
  }
} catch (error) {
  const { formatCliFailureLines, formatCliJsonFailure } = await import("./failure-output.js");
  const { isJsonOutputModeActive } = await import("./json-output-mode.js");
  if (isJsonOutputModeActive(process.argv)) {
    writeJson(formatCliJsonFailure(error));
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
