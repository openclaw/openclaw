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
  startCliReadGateway,
} from "./gateway-backed-exit.test-helpers.js";

async function prepareMessageReadPlugin(root: string): Promise<string> {
  const bundledDir = path.join(root, "extensions");
  const pluginDir = path.join(bundledDir, "discord");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/discord",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "discord",
      channels: ["discord"],
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  // Exercise discovery and Gateway routing without requiring built plugin SDK artifacts.
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `const plugin = {
  id: "discord",
  meta: { id: "discord", label: "Synthetic Discord", docsPath: "/channels/discord", blurb: "CLI read fixture" },
  capabilities: { chatTypes: ["channel"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", enabled: true, configured: true }),
    isConfigured: () => true,
  },
  outbound: { deliveryMode: "gateway" },
  messaging: { targetResolver: { looksLikeId: () => true } },
  actions: {
    resolveExecutionMode: () => "gateway",
    supportsAction: ({ action }) => action === "read",
    handleAction: () => { throw new Error("Message reads must execute through the Gateway"); },
  },
};
export default {
  kind: "bundled-channel-entry",
  id: "discord",
  name: "Synthetic Discord",
  description: "CLI read fixture",
  register(api) { api.registerChannel({ plugin }); },
  loadChannelPlugin: () => plugin,
};
`,
  );
  return bundledDir;
}

it.each([
  { name: "RPC diagnostics", message: false },
  { name: "message reads", message: true },
])("keeps $name startup free of unnecessary shared-state work", async ({ message }) => {
  const root = tempDirs.make("openclaw-cli-diagnostics-opens-");
  const bundledDir = message ? await prepareMessageReadPlugin(root) : undefined;
  const token = message ? "synthetic-message-gateway-token" : undefined;
  const gateway = await startCliReadGateway(token);
  const port = Number(new URL(gateway.url).port);
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "local",
    port,
    auth: token ? { mode: "token", token } : { mode: "none" },
  });
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ...config,
      ...(message
        ? {
            agents: { entries: { main: {} } },
            channels: { discord: { enabled: true, token: "synthetic-discord-token" } },
          }
        : {}),
      diagnostics: { flags: ["timeline"] },
    }),
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
if (process.argv.includes("--openclaw-sqlite-readonly-child")) record({ kind: "snapshot" });
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = function(prefix, ...rest) {
  if (String(prefix).includes("openclaw-plugin-build-")) record({ kind: "capture" });
  return mkdtemp.call(this, prefix, ...rest);
};
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
      const commands = message
        ? [
            [
              "message",
              "read",
              "--channel",
              "discord",
              "--target",
              "123456789012345678",
              "--limit",
              "1",
            ],
          ]
        : [
            ["cron", "list"],
            ["gateway", "call", "cron.status"],
          ];
      for (const args of commands) {
        await fs.writeFile(opensPath, "");
        await fs.writeFile(timelinePath, "");
        const result = await runIsolatedGatewayCli({
          args: [
            ...args,
            "--json",
            ...(!online && args[0] !== "message" ? ["--timeout", "250"] : []),
          ],
          root,
          stateDir,
          configPath,
          env: {
            ...sqliteWorkerPreloadEnv(preloadPath),
            OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
            OPENCLAW_DIAGNOSTICS: undefined,
            ...(bundledDir
              ? {
                  OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
                  OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
                  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
                }
              : {}),
          },
        });
        expect(result, result.stderr).toMatchObject({ code: online ? 0 : 1, signal: null });
        if (online) {
          expect(JSON.parse(result.stdout)).toMatchObject(
            args[0] === "message"
              ? { action: "read", channel: "discord", payload: { messages: [] } }
              : args[0] === "cron"
                ? { jobs: [] }
                : { enabled: true },
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
        counts[
          `${online ? "online" : "offline"} ${args.slice(0, args[0] === "gateway" ? 3 : 2).join(" ")}`
        ] = events.filter((event) =>
          message
            ? event.kind === "snapshot" || event.kind === "capture"
            : event.kind !== "preload",
        );
      }
    }
    expect(counts).toEqual(
      message
        ? { "online message read": [], "offline message read": [] }
        : {
            "online cron list": [],
            "online gateway call cron.status": [],
            "offline cron list": [],
            "offline gateway call cron.status": [],
          },
    );
  } finally {
    await lock?.release();
  }
});
