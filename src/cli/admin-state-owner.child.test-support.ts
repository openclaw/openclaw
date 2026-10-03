import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import * as json5 from "json5";
import { resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { registerSealedRuntime } from "../infra/sealed-runtime-registry.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";
import { installCliSignalExitHandlers } from "./signal-exit-barrier.js";

const control = path.join(process.env.OPENCLAW_HOME!, "control");
fs.mkdirSync(control, { recursive: true });
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
installCliSignalExitHandlers();
const native = requireNodeSqlite();
const ownerPath = resolveGatewayLockPaths(process.env).ownerLockPath;
let adminSql = 0;
let missingCustody = 0;
const ownerPids = new Set<number>();
const observe = (sql: string) => {
  if (!/\b(?:channel_pairing_\w+|exec_approvals_config)\b/iu.test(sql)) {
    return;
  }
  adminSql += 1;
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
    JSON.stringify({ pid: process.pid, adminSql, missingCustody, ownerPids: [...ownerPids] }),
  );
});
try {
  await runCliWithExitFinalization({
    run: () =>
      withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const program = new Command().name("openclaw").exitOverride();
          if (process.argv[2] === "pairing") {
            const { registerPairingCli } = await import("./pairing-cli.js");
            registerPairingCli(program);
          } else {
            const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
            registerExecApprovalsCli(program);
          }
          await program.parseAsync(process.argv.slice(2), { from: "user" });
        },
        { retainRoutingUntilProcessExit: true },
      ),
    onError: (error) => {
      throw error;
    },
  });
} catch (error) {
  const { formatCliFailureLines } = await import("./failure-output.js");
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
