// Test-only process schedule and owner-state assertions for native launchd settlement.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export function assertNoLaunchdFixtureStateLeases(db: DatabaseSync): void {
  if (!tableExists(db, "state_leases")) {
    return;
  }
  const lease = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
      .selectFrom("state_leases")
      .select(["scope", "lease_key"])
      .limit(1),
  );
  if (lease !== undefined) {
    throw new Error("Plain Node launchd fixture unexpectedly acquired a state lease");
  }
}

export function buildLaunchdSettlementProbe(params: {
  eventsPath: string;
  releasePath: string;
  port: number;
}): string {
  return [
    'const fs = require("node:fs");',
    `const eventsPath = ${JSON.stringify(params.eventsPath)};`,
    `const releasePath = ${JSON.stringify(params.releasePath)};`,
    'const events = fs.readFileSync(eventsPath, "utf8").split("\\n").filter(Boolean).map(JSON.parse);',
    'const ordinal = events.filter((event) => event.event === "start").length + 1;',
    'const record = (event) => fs.appendFileSync(eventsPath, JSON.stringify({ event, ordinal, pid: process.pid }) + "\\n");',
    'record("start");',
    "if (ordinal === 1) {",
    // Keep the first real process alive until the waiter reaches its grace boundary.
    // Its immediate successor then exits inside launchd's unchanged 10-second throttle.
    "  const poll = setInterval(() => {",
    "    if (fs.existsSync(releasePath)) {",
    "      clearInterval(poll);",
    "      clearTimeout(deadline);",
    '      record("exit");',
    "      process.exit(0);",
    "    }",
    "  }, 50);",
    "  const deadline = setTimeout(() => {",
    '    record("gate-timeout");',
    "    process.exit(2);",
    "  }, 40_000);",
    "} else if (ordinal === 2) {",
    '  record("exit");',
    "  process.exit(0);",
    "} else if (ordinal === 3) {",
    '  require("node:net").createServer((socket) => socket.end())',
    `    .listen(${params.port}, "127.0.0.1", () => record("listen"));`,
    "} else {",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n");
}
