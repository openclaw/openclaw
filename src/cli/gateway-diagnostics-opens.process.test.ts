import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  prepareGatewayCliFixture,
  runIsolatedGatewayCli,
  tempDirs,
} from "./gateway-backed-exit.process.test-support.js";
import {
  closeActiveGatewayServers,
  startCronListGateway,
} from "./gateway-backed-exit.test-helpers.js";

it("keeps timeline diagnostics off shared state for online and offline local RPCs", async () => {
  const root = tempDirs.make("openclaw-cli-diagnostics-opens-");
  const gateway = await startCronListGateway();
  const port = Number(new URL(gateway.url).port);
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "local",
    port,
    auth: { mode: "none" },
  });
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    JSON.stringify({ ...config, diagnostics: { flags: ["timeline"] } }),
  );
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  openOpenClawStateDatabase({ path: databasePath });
  closeOpenClawStateDatabaseForTest();
  const lock = await acquireGatewayLock({
    allowInTests: true,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    port,
  });
  expect(lock).not.toBeNull();
  const opensPath = path.join(root, "opens.jsonl");
  const preloadPath = path.join(root, "count-opens.cjs");
  const timelinePath = path.join(root, "timeline.jsonl");
  await fs.writeFile(
    preloadPath,
    `const fs = require("node:fs");
const sqlite = require("node:sqlite");
const record = (event) => fs.appendFileSync(${JSON.stringify(opensPath)}, JSON.stringify(event) + "\\n");
const open = fs.openSync;
fs.openSync = function(file, flags, ...rest) {
  if (String(file) === ${JSON.stringify(databasePath)}) {
    record({ kind: "source", flags, stack: new Error().stack });
  }
  return open.call(this, file, flags, ...rest);
};
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    record({ kind: "sqlite", path: String(args[0]) });
    return Reflect.construct(target, args, newTarget);
  }
});
require("node:module").syncBuiltinESMExports();
record({ kind: "preload" });
`,
  );
  const counts: Record<string, unknown[]> = {};
  try {
    for (const online of [true, false]) {
      if (!online) {
        await closeActiveGatewayServers();
        await lock?.release();
      }
      for (const args of [
        ["cron", "list"],
        ["gateway", "call", "cron.status"],
      ]) {
        await fs.writeFile(opensPath, "");
        await fs.writeFile(timelinePath, "");
        const result = await runIsolatedGatewayCli({
          args: [...args, "--json", ...(!online ? ["--timeout", "250"] : [])],
          root,
          stateDir,
          configPath,
          env: {
            ...sqliteWorkerPreloadEnv(preloadPath),
            OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
            OPENCLAW_DIAGNOSTICS: undefined,
          },
        });
        expect(result, result.stderr).toMatchObject({ code: online ? 0 : 1, signal: null });
        if (online) {
          expect(JSON.parse(result.stdout)).toMatchObject(
            args[0] === "cron" ? { jobs: [] } : { enabled: true },
          );
        } else {
          expect(result.stdout + result.stderr).toContain("Gateway not reachable");
        }
        expect(await fs.readFile(timelinePath, "utf8")).toContain("cli.main.argv");
        const events = (await fs.readFile(opensPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind: string });
        expect(events).toContainEqual({ kind: "preload" });
        counts[`${online ? "online" : "offline"} ${args.join(" ")}`] = events.filter(
          (event) => event.kind !== "preload",
        );
      }
    }
    expect(counts).toEqual({
      "online cron list": [],
      "online gateway call cron.status": [],
      "offline cron list": [],
      "offline gateway call cron.status": [],
    });
  } finally {
    await lock?.release();
  }
});
