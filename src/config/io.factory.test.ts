import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";

const roots = createSuiteTempRootTracker({ prefix: "openclaw-config-factory-" });
beforeAll(() => roots.setup());
beforeEach(() => vi.resetModules());
afterEach(async () => {
  vi.doUnmock("./io.write.js");
  const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
  closeOpenClawStateDatabaseForTest();
});
afterAll(() => roots.cleanup());

const gateway = (port = 18789) => ({ gateway: { mode: "local" as const, port } });
const catalog = (enabled = false) => ({ config: { sessionCatalog: { enabled } } });

async function fixture(absent = false) {
  const home = await roots.make();
  const configPath = path.join(home, "openclaw.json");
  const raw = JSON.stringify(gateway());
  if (!absent) {
    await fs.writeFile(configPath, raw);
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    ...(absent ? { OPENCLAW_STATE_DIR: home } : { NODE_ENV: "test" }),
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const { createConfigIO } = await import("./io.factory.js");
  const logger = { warn: vi.fn(), error: vi.fn() };
  const io = createConfigIO({ env, homedir: () => home, logger });
  const readRaw = () => fs.readFile(configPath, "utf8");
  const saved = async () => JSON.parse(await readRaw());
  const health = async () => {
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
      await import("../infra/kysely-sync.js");
    const { db } = openOpenClawStateDatabase({ env });
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "config_health_entries">>(db)
        .selectFrom("config_health_entries")
        .selectAll()
        .where("config_path", "=", configPath),
    );
  };
  return { io, env, home, configPath, raw, readRaw, saved, health };
}

it.each([
  { absent: true, enabled: undefined },
  { absent: true, enabled: true },
  { absent: false, enabled: undefined },
])("preserves catalog privacy (absent=$absent, explicit=$enabled)", async ({ absent, enabled }) => {
  const { io, saved } = await fixture(absent);
  await io.writeConfigFile({
    gateway: { mode: "local", ...(absent ? {} : { port: 19001 }) },
    ...(enabled === undefined ? {} : { plugins: { entries: { codex: catalog(enabled) } } }),
  });
  const { plugins } = await saved();
  expect(plugins?.entries?.codex).toEqual(absent ? catalog(enabled) : undefined);
  expect(plugins?.entries?.anthropic).toEqual(absent ? catalog() : undefined);
  if (absent) {
    expect(plugins?.installs).toBeUndefined();
  }
  if (absent && enabled !== true) {
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    expect(snapshot.warnings).not.toContainEqual(
      expect.objectContaining({ path: "plugins.entries.codex" }),
    );
  }
});

it("reads and records normal observation without importing the writer", async () => {
  const loadWriter = vi.fn().mockRejectedValue(new Error("read imported the config writer"));
  // mock-isolation: Fail if the read-only path imports the config writer.
  vi.doMock("./io.write.js", loadWriter);
  const { io, configPath, raw, readRaw, health } = await fixture();

  expect(io.loadConfig().gateway?.port).toBe(18789);
  const snapshot = await io.readBestEffortConfigSnapshot();
  expect(snapshot.configDiagnostics).toBeNull();
  expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
  expect(snapshot.sourceConfig.agents?.defaults?.compaction).toBeUndefined();
  expect(await health()).toMatchObject({
    config_path: configPath,
    last_known_good_json: expect.any(String),
  });
  expect(await readRaw()).toBe(raw);
  expect(loadWriter).not.toHaveBeenCalled();
});

it("honors per-call unobserved mutation reads without disabling write auditing", async () => {
  const { io, env, home, configPath, saved, health } = await fixture();
  const { listConfigAuditRecordsForTests } = await import("./io.audit.test-support.js");
  const { transformConfigFileWithRetry } = await import("./mutate.js");
  const mutate = (transform: Parameters<typeof transformConfigFileWithRetry>[0]["transform"]) =>
    transformConfigFileWithRetry({ io, writeOptions: { observe: false }, transform });
  const audit = () => listConfigAuditRecordsForTests({ env, homedir: () => home });
  await io.readConfigFileSnapshotForWrite();
  const beforeHealth = await health();
  const beforeAudit = audit();
  expect(beforeHealth?.last_known_good_json).toEqual(expect.any(String));
  await fs.writeFile(configPath, JSON.stringify(gateway(19001)) + "\n");

  const failure = new Error("mutation declined before committing");
  await expect(
    mutate(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect([await health(), audit()]).toEqual([beforeHealth, beforeAudit]);

  await mutate((config) => ({
    nextConfig: { ...config, gateway: { ...config.gateway, port: 19002 } },
  }));
  expect(await health()).toEqual(beforeHealth);
  expect(audit()).toContainEqual(
    expect.objectContaining({ event: "config.write", configPath, result: "rename" }),
  );
  expect((await saved()).gateway.port).toBe(19002);

  await io.readConfigFileSnapshotForWrite();
  expect((await health())?.last_known_good_json).not.toBe(beforeHealth?.last_known_good_json);
});

it.each(["path", "snapshot"] as const)("rechecks %s after writer import", async (change) => {
  const entered = createDeferred();
  const release = createDeferred();
  vi.doMock("./io.write.js", async (importOriginal) => {
    entered.resolve();
    await release.promise;
    return importOriginal();
  });
  const { io, env, home, configPath, raw, readRaw } = await fixture();
  const secondPath = path.join(home, "second.json");
  await fs.writeFile(secondPath, raw);
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  const write = io.writeConfigFile(gateway(19002), { ...writeOptions, baseSnapshot: snapshot });
  const subject = change === "path" ? "config path" : "config";
  const rejected = expect(write).rejects.toThrow(`${subject} changed since last load`);
  let expectedRaw = raw;
  try {
    await entered.promise;
    if (change === "path") {
      env.OPENCLAW_CONFIG_PATH = secondPath;
    } else {
      expectedRaw = JSON.stringify(gateway(19003));
      await fs.writeFile(configPath, expectedRaw);
    }
  } finally {
    release.resolve();
  }
  await rejected;
  expect(await readRaw()).toBe(expectedRaw);
  expect(await fs.readFile(secondPath, "utf8")).toBe(raw);
});
