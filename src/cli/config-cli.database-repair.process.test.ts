import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

async function fixture() {
  const root = roots.make("openclaw-database-config-repair-");
  const configPath = path.join(root, "openclaw.json");
  const statePath = path.join(root, "state", "openclaw.sqlite");
  await fs.writeFile(configPath, JSON.stringify({ database, gateway: { mode: "local" } }));
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
  return { root, configPath, statePath, env };
}

describe("database-only config repair without a PostgreSQL connection", () => {
  it.each(["set", "batch", "patch", "unset", "fast unset"])(
    "repairs through %s without creating or opening shared state",
    async (command) => {
      const { configPath, statePath, root, env } = await fixture();
      // Existing state is deliberately unreadable: config-only repair must not inspect it.
      const originalState = Buffer.from("unavailable shared state\n");
      if (command === "patch") {
        await fs.mkdir(path.dirname(statePath));
        await fs.writeFile(statePath, originalState);
      }
      let args: string[];
      if (command === "set") {
        args = ["config", "set", "database.postgres.connection.id", "OPENCLAW_REPAIRED_DSN"];
      } else if (command === "batch") {
        args = [
          "config",
          "set",
          "--batch-json",
          JSON.stringify([
            { path: "database.postgres.connection.id", value: "OPENCLAW_REPAIRED_DSN" },
            { path: "database.postgres.schemaPrefix", value: "repaired" },
          ]),
        ];
      } else if (command === "patch") {
        const patchPath = path.join(root, "patch.json");
        await fs.writeFile(
          patchPath,
          JSON.stringify({
            database: { postgres: { connection: { id: "OPENCLAW_REPAIRED_DSN" } } },
          }),
        );
        args = ["config", "patch", "--file", patchPath];
      } else if (command === "fast unset") {
        args = ["config-unset-route", "database"];
      } else {
        args = ["config", "unset", "database"];
      }
      const result = await runCliProcessChild({ nodeArgs: [...entrypoint, ...args], env });
      expect(result.code, result.stderr).toBe(0);
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (command.endsWith("unset")) {
        expect(config.database).toBeUndefined();
      } else {
        expect(config.database.postgres.connection.id).toBe("OPENCLAW_REPAIRED_DSN");
      }
      expect(config.gateway).toEqual({ mode: "local" });
      if (command === "patch") {
        expect(await fs.readFile(statePath)).toEqual(originalState);
        expect(await fs.readdir(path.dirname(statePath))).toEqual(["openclaw.sqlite"]);
      } else {
        await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each(["batch", "patch"])("requires the selected engine for a mixed %s", async (mode) => {
    const { configPath, statePath, env } = await fixture();
    const originalConfig = await fs.readFile(configPath, "utf8");
    const args =
      mode === "batch"
        ? [
            "config",
            "set",
            "--batch-json",
            JSON.stringify([
              { path: "database.postgres.schemaPrefix", value: "repaired" },
              { path: "gateway.port", value: 19002 },
            ]),
          ]
        : ["config", "patch", "--stdin"];
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, ...args],
      env,
      ...(mode === "patch"
        ? {
            input: '{"database":{"postgres":{"schemaPrefix":"repaired"}},"gateway":{"port":19002}}',
          }
        : {}),
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("SecretRef is unresolved");
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["set", "patch", "unset"])(
    "requires PostgreSQL selection for a %s preview without writing local state",
    async (command) => {
      const { configPath, statePath, env } = await fixture();
      const originalConfig = await fs.readFile(configPath, "utf8");
      const args =
        command === "set"
          ? ["config", "set", "gateway.port", "19002"]
          : command === "patch"
            ? ["config", "patch", "--stdin"]
            : ["config", "unset", "gateway.mode"];
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, ...args, "--dry-run"],
        env,
        ...(command === "patch" ? { input: '{"gateway":{"port":19002}}' } : {}),
      });
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("SecretRef is unresolved");
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
      await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["set", "patch", "unset"])(
    "previews a database-only %s without credentials or database access",
    async (command) => {
      const { configPath, statePath, env } = await fixture();
      const originalConfig = await fs.readFile(configPath, "utf8");
      const originalState = Buffer.from("unavailable shared state\n");
      await fs.mkdir(path.dirname(statePath));
      await fs.writeFile(statePath, originalState);
      const args =
        command === "set"
          ? ["config", "set", "database.postgres.schemaPrefix", '"repaired"']
          : command === "patch"
            ? ["config", "patch", "--stdin"]
            : ["config", "unset", "database"];
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, ...args, "--dry-run", "--json"],
        env,
        ...(command === "patch"
          ? { input: '{"database":{"postgres":{"schemaPrefix":"repaired"}}}' }
          : {}),
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operations: 1 });
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
      expect(await fs.readFile(statePath)).toEqual(originalState);
      expect(await fs.readdir(path.dirname(statePath))).toEqual(["openclaw.sqlite"]);
    },
  );

  it("reports malformed PostgreSQL config before resolving its missing credentials", async () => {
    const { configPath, statePath, env } = await fixture();
    const malformed = (await fs.readFile(configPath, "utf8")).slice(0, -1);
    await fs.writeFile(configPath, malformed);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "validate", "--json"],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      path: configPath,
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("JSON5") }),
      ]),
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(malformed);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates the redirected source after selecting its engine", async () => {
    const { root, env } = await fixture();
    const bootstrapDir = path.join(root, ".openclaw");
    const targetDir = path.join(root, "redirected");
    const targetPath = path.join(targetDir, "openclaw.json");
    await fs.mkdir(bootstrapDir);
    await fs.mkdir(targetDir);
    await fs.writeFile(
      path.join(bootstrapDir, "openclaw.json"),
      JSON.stringify({ env: { vars: { OPENCLAW_STATE_DIR: targetDir } } }),
    );
    await fs.writeFile(targetPath, JSON.stringify({ gateway: { port: "invalid" } }));
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "validate", "--json"],
      env: { ...env, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined },
    });
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: false, path: targetPath });
    await expect(
      fs.access(path.join(bootstrapDir, "state", "openclaw.sqlite")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(targetDir, "state", "openclaw.sqlite"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("requires PostgreSQL selection to validate a readable config", async () => {
    const { configPath, statePath, env } = await fixture();
    const originalConfig = await fs.readFile(configPath, "utf8");
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "validate", "--json"],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      error: { message: expect.stringContaining("SecretRef is unresolved") },
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains live-owner refusal for database-only repairs", async () => {
    const { configPath, env } = await fixture();
    const originalConfig = await fs.readFile(configPath, "utf8");
    const owner = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
    try {
      const result = await runCliProcessChild({
        nodeArgs: [...entrypoint, "config", "unset", "database"],
        env,
      });
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("exclusive offline state ownership");
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    } finally {
      await owner?.release();
    }
  });

  it("preserves configured providers without loading their shared metadata", async () => {
    const { configPath, statePath, env } = await fixture();
    const models = {
      providers: {
        example: {
          baseUrl: "http://127.0.0.1:12345",
          api: "openai-completions",
          models: [{ id: "synthetic", name: "Synthetic" }],
        },
      },
    };
    await fs.writeFile(
      configPath,
      JSON.stringify({ database, gateway: { mode: "local" }, models }),
    );
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "set", "database.postgres.schemaPrefix", "repaired"],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.database.postgres.schemaPrefix).toBe("repaired");
    expect(config.models).toEqual(models);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs an included database config without shared state", async () => {
    const { root, configPath, statePath, env } = await fixture();
    const includePath = path.join(root, "database.json");
    await fs.writeFile(includePath, JSON.stringify(database));
    const originalRoot = JSON.stringify({
      database: { $include: "./database.json" },
      gateway: { mode: "local" },
    });
    await fs.writeFile(configPath, originalRoot);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "set", "database.postgres.schemaPrefix", "repaired"],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await fs.readFile(includePath, "utf8")).postgres.schemaPrefix).toBe(
      "repaired",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(originalRoot);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still validates the database config before publishing a repair", async () => {
    const { configPath, statePath, env } = await fixture();
    const originalConfig = await fs.readFile(configPath, "utf8");
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config", "set", "database.engine", "unsupported"],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("database.engine");
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies database work inside config-only custody", async () => {
    const { statePath, env } = await fixture();
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config-only-denial"],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("Config-only ownership does not admit database access");
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates core config without resolving the database connection", async () => {
    const { statePath, env } = await fixture();
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, "config-validation-only"],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
