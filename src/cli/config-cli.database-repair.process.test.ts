import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);
const database = {
  engine: "postgres",
  postgres: {
    connection: { source: "env", provider: "default", id: "OPENCLAW_MISSING_REPAIR_DSN" },
  },
};
const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const originalState = Buffer.from("unavailable shared state\n");
const schemaRepair = ["config", "set", "database.postgres.schemaPrefix", "repaired"];
const patchStdin = ["config", "patch", "--stdin"];
const mixedPatch = '{"database":{"postgres":{"schemaPrefix":"repaired"}},"gateway":{"port":19002}}';
const unresolved = "SecretRef is unresolved";
const preservedConfig = {
  gateway: { mode: "local" },
  plugins: { entries: { brave: { enabled: true } } },
  models: {
    providers: {
      example: {
        baseUrl: "http://127.0.0.1:12345",
        api: "openai-completions",
        models: [{ id: "synthetic", name: "Synthetic" }],
      },
    },
  },
};
const batch = (entries: [string, unknown][]) => [
  "config",
  "set",
  "--batch-json",
  JSON.stringify(entries.map(([key, value]) => ({ path: key, value }))),
];

async function fixture(existingState = false) {
  const root = roots.make("openclaw-database-config-repair-");
  const configPath = path.join(root, "openclaw.json");
  const statePath = path.join(root, "state", "openclaw.sqlite");
  const originalConfig = JSON.stringify({ database, gateway: { mode: "local" } });
  await fs.writeFile(configPath, originalConfig);
  // Unreadable shared state detects accidental database access by config-only repairs.
  if (existingState) {
    await fs.mkdir(path.dirname(statePath));
    await fs.writeFile(statePath, originalState);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DEBUG: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  return {
    root,
    configPath,
    env,
    async run(args: string[], code = 0, input?: string) {
      const result = await runCliProcessChild({ nodeArgs: [...entrypoint, ...args], env, input });
      expect(result.code, result.stderr).toBe(code);
      return result;
    },
    unchanged: async () => expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig),
    async checkState() {
      if (existingState) {
        expect(await fs.readFile(statePath)).toEqual(originalState);
        expect(await fs.readdir(path.dirname(statePath))).toEqual(["openclaw.sqlite"]);
      } else {
        await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  };
}

it.each(["set", "batch", "patch", "unset", "fast unset"] as const)(
  "repairs through %s preserving plugins and providers without opening shared state",
  async (command) => {
    const f = await fixture(true);
    await writeJson(f.configPath, { database, ...preservedConfig });
    const connection = "database.postgres.connection.id";
    const repaired = "OPENCLAW_REPAIRED_DSN";
    const patchPath = path.join(f.root, "patch.json");
    if (command === "patch") {
      await writeJson(patchPath, { database: { postgres: { connection: { id: repaired } } } });
    }
    const args = {
      set: ["config", "set", connection, repaired],
      batch: batch([
        [connection, repaired],
        ["database.postgres.schemaPrefix", "repaired"],
      ]),
      patch: ["config", "patch", "--file", patchPath],
      unset: ["config", "unset", "database"],
      "fast unset": ["config-unset-route", "database"],
    };
    await f.run(args[command]);
    const config = await readJson(f.configPath);
    if (command.endsWith("unset")) {
      expect(config.database).toBeUndefined();
    } else {
      expect(config.database.postgres.connection.id).toBe(repaired);
    }
    expect({ gateway: config.gateway, plugins: config.plugins, models: config.models }).toEqual(
      preservedConfig,
    );
    if (command === "batch") {
      expect(config.database.postgres.schemaPrefix).toBe("repaired");
    }
    await f.checkState();
  },
);

it.each([
  [
    "mixed batch",
    batch([
      ["database.postgres.schemaPrefix", "repaired"],
      ["gateway.port", 19002],
    ]),
    unresolved,
  ],
  ["mixed patch", patchStdin, unresolved, mixedPatch],
  ["set preview", ["config", "set", "gateway.port", "19002", "--dry-run"], unresolved],
  ["patch preview", [...patchStdin, "--dry-run"], unresolved, '{"gateway":{"port":19002}}'],
  ["unset preview", ["config", "unset", "gateway.mode", "--dry-run"], unresolved],
  ["readable config validation", ["config", "validate", "--json"], unresolved, undefined, true],
  ["invalid engine", ["config", "set", "database.engine", "unsupported"], "database.engine"],
  [
    "database access in config-only custody",
    ["config-only-denial"],
    "Config-only ownership does not admit database access",
  ],
] satisfies [string, string[], string, string?, boolean?][])(
  "rejects %s without changing config or shared state",
  async (_name, args, error, input?: string, json?: boolean) => {
    const f = await fixture();
    const result = await f.run(args, 1, input);
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        valid: false,
        error: { message: expect.stringContaining(error) },
      });
    } else {
      expect(result.stderr).toContain(error);
    }
    await f.unchanged();
    await f.checkState();
  },
);

it.each([
  ["set", ["config", "set", "database.postgres.schemaPrefix", '"repaired"']],
  ["patch", patchStdin, '{"database":{"postgres":{"schemaPrefix":"repaired"}}}'],
  ["unset", ["config", "unset", "database"]],
] satisfies [string, string[], string?][])(
  "previews a database-only %s without credentials or database access",
  async (_command, args, input?: string) => {
    const f = await fixture(true);
    const result = await f.run([...args, "--dry-run", "--json"], 0, input);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operations: 1 });
    await f.unchanged();
    await f.checkState();
  },
);

it("reports malformed PostgreSQL config before resolving its missing credentials", async () => {
  const f = await fixture();
  const malformed = (await fs.readFile(f.configPath, "utf8")).slice(0, -1);
  await fs.writeFile(f.configPath, malformed);
  const result = await f.run(["config", "validate", "--json"], 1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    valid: false,
    path: f.configPath,
    issues: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("JSON5") }),
    ]),
  });
  expect(await fs.readFile(f.configPath, "utf8")).toBe(malformed);
  await f.checkState();
});

it("validates the redirected source after selecting its engine", async () => {
  const { root, env } = await fixture();
  const bootstrapDir = path.join(root, ".openclaw");
  const targetDir = path.join(root, "redirected");
  const targetPath = path.join(targetDir, "openclaw.json");
  await fs.mkdir(bootstrapDir);
  await fs.mkdir(targetDir);
  await writeJson(path.join(bootstrapDir, "openclaw.json"), {
    env: { vars: { OPENCLAW_STATE_DIR: targetDir } },
  });
  await writeJson(targetPath, { gateway: { port: "invalid" } });
  const result = await runCliProcessChild({
    nodeArgs: [...entrypoint, "config", "validate", "--json"],
    env: { ...env, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
  });
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, path: targetPath });
  for (const dir of [bootstrapDir, targetDir]) {
    await expect(fs.access(path.join(dir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("retains live-owner refusal for database-only repairs", async () => {
  const f = await fixture();
  const owner = await acquireGatewayLock({ env: f.env, allowInTests: true, timeoutMs: 0 });
  expect(owner).not.toBeNull();
  try {
    const result = await f.run(["config", "unset", "database"], 1);
    expect(result.stderr).toContain("exclusive offline state ownership");
    await f.unchanged();
  } finally {
    await owner?.release();
  }
});

it("repairs an included database config without shared state", async () => {
  const f = await fixture();
  const includePath = path.join(f.root, "database.json");
  await writeJson(includePath, database);
  const originalRoot = JSON.stringify({
    database: { $include: "./database.json" },
    gateway: { mode: "local" },
  });
  await fs.writeFile(f.configPath, originalRoot);
  await f.run(schemaRepair);
  expect((await readJson(includePath)).postgres.schemaPrefix).toBe("repaired");
  expect(await fs.readFile(f.configPath, "utf8")).toBe(originalRoot);
  await f.checkState();
});

it("validates core config without resolving the database connection", async () => {
  const f = await fixture();
  await f.run(["config-validation-only"]);
  await f.checkState();
});
