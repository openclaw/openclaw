import fs from "node:fs/promises";
import path from "node:path";

export async function writeAdminStateOwnerObservationPreload(root: string, ownerPath: string) {
  const control = path.join(root, "control");
  const preloadPath = path.join(control, "observe-admin-sql.cjs");
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(
    preloadPath,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const workerThreads = require("node:worker_threads");
const { isMainThread, threadId } = workerThreads;
const native = require("node:sqlite");
const eventsPath = ${JSON.stringify(path.join(control, "sql-observation.jsonl"))};
const ownerPath = ${JSON.stringify(ownerPath)};
if (isMainThread) fs.writeFileSync(eventsPath, "");
if (process.versions.bun) {
  const OriginalWorker = workerThreads.Worker;
  const preload = process.env.OPENCLAW_TEST_SQLITE_WORKER_PRELOAD;
  // Nested CLI workers do not inherit the Vitest parent's preload spy.
  workerThreads.Worker = class Worker extends OriginalWorker {
    constructor(filename, options = {}) {
      super(filename, {
        ...options,
        execArgv: [...(options.execArgv ?? process.execArgv), "--preload", preload],
      });
    }
  };
}
const observe = (sql) => {
  const admin = /\\b(?:channel_pairing_\\w+|exec_approvals_config)\\b/iu.test(sql);
  const write = /^\\s*(?:insert|update|delete)\\b/iu.test(sql);
  const secretWrite = write && /\\bsecret_store_entries\\b/iu.test(sql);
  const catalogWrite = write && /\\bconfig_machine_state\\b/iu.test(sql);
  if (!admin && !secretWrite && !catalogWrite) return;
  let ownerPid;
  try {
    ownerPid = JSON.parse(fs.readFileSync(ownerPath, "utf8")).pid;
  } catch {}
  fs.appendFileSync(eventsPath, JSON.stringify({ threadId, ownerPid, admin, secretWrite, catalogWrite }) + "\\n");
};
for (const method of ["prepare", "exec"]) {
  Object.defineProperty(native.DatabaseSync.prototype, method, {
    ...Object.getOwnPropertyDescriptor(native.DatabaseSync.prototype, method),
    value: new Proxy(native.DatabaseSync.prototype[method], {
      apply(target, receiver, args) {
        observe(args[0]);
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
}
for (const method of ["get", "all", "run", "iterate"]) {
  Object.defineProperty(native.StatementSync.prototype, method, {
    ...Object.getOwnPropertyDescriptor(native.StatementSync.prototype, method),
    value: new Proxy(native.StatementSync.prototype[method], {
      apply(target, receiver, args) {
        observe(receiver.sourceSQL);
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
}
syncBuiltinESMExports();
if (isMainThread) process.on("exit", () => {
  const events = fs.readFileSync(eventsPath, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
  fs.writeFileSync(${JSON.stringify(path.join(control, "sql-observation.json"))}, JSON.stringify({
    pid: process.pid,
    adminSql: events.filter((event) => event.admin).length,
    workerSql: events.filter((event) => event.admin && event.threadId !== 0).length,
    secretWrites: events.filter((event) => event.secretWrite).length,
    catalogWrites: events.filter((event) => event.catalogWrite).length,
    missingCustody: events.filter((event) => event.ownerPid === undefined).length,
    ownerPids: [...new Set(events.flatMap((event) => event.ownerPid === undefined ? [] : [event.ownerPid]))],
  }));
});
`,
  );
  return preloadPath;
}
