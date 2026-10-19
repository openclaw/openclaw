import "../src/test-utils/prepare-compiled-subprocesses.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  withCliHome,
  expectCliError,
  expectMissing,
  writeJson,
  cliCase,
} from "./cli-json-stdout-contract.test-support.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

it.each([
  { name: "routed agents list", overrides: {} },
  { name: "Commander agents list", overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } },
])("drains large invalid-config JSON for $name", async ({ overrides }) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    const agentIds = Array.from({ length: 16_384 }, (_, index) => `agent_${index}`);
    const config = JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(agentIds.map((id) => [id, { workspace: 42 }])),
      },
    });
    await fs.writeFile(configPath, config);

    const result = runBuiltCli(
      tempHome,
      ["agents", "list", "--json"],
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.join(tempHome, "state"),
        ...overrides,
      },
      { inheritEnvironment: false },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining("OpenClaw config is invalid:"),
      },
      issues: agentIds.map((id) => ({
        path: `agents.entries.${id}.workspace`,
        message: "Invalid input: expected string, received number",
      })),
    });
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(1024 * 1024);
    expect(result.stderr).toBe("");
    expect(await fs.readFile(configPath, "utf8")).toBe(config);
  });
});

it.each([
  ["memory", "status", "--json"],
  ["nodes", "canvas", "snapshot", "--json"],
])("reports invalid config before discovering plugin command %s", async (...args) => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    const stateDir = path.join(tempHome, "state");
    await writeJson(configPath, { gateway: { port: "invalid-port" } });

    const result = runBuiltCli(
      tempHome,
      args,
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
      { inheritEnvironment: false },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { type: "cli_error", message: expect.stringContaining("Invalid config at") },
    });
    expect(result.stdout).toContain("gateway.port");
    expect(result.stderr).toContain("openclaw doctor");
    await expectMissing(path.join(stateDir, "state", "openclaw.sqlite"));
  });
});

it.each([
  cliCase("node identity --json", {
    overrides: {},
    error:
      "no node device identity found (start the node host once with `openclaw node run` or `openclaw node install`)",
  }),
  cliCase("config get gateway.port --json", { overrides: {} }),
  cliCase("config get gateway.port --json", { overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } }),
  cliCase("config get gateway.port --json", { overrides: { OPENCLAW_NIX_MODE: "1" } }),
  cliCase("config schema", { overrides: {} }),
  cliCase("config schema", { overrides: { OPENCLAW_NIX_MODE: "1" } }),
  cliCase("config validate --json", { overrides: {} }),
  cliCase("config validate --json", { overrides: { OPENCLAW_NIX_MODE: "1" } }),
])("does not initialize shared SQLite for $name", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const stateDir = path.join(tempHome, "read-only-state");
    const configPath = path.join(tempHome, "read-only-openclaw.json");
    const config = `${JSON.stringify({
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: randomBytes(32).toString("hex") },
      },
      plugins: { enabled: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      logging: { file: path.join(stateDir, "openclaw.log") },
    })}\n`;
    await fs.writeFile(configPath, config, "utf8");
    const { ino, mode, mtimeMs, ctimeMs } = await fs.stat(configPath);
    const tmpDir = path.join(tempHome, "tmp");
    await fs.mkdir(tmpDir);

    const result = runBuiltCli(
      tempHome,
      testCase.args,
      {
        OPENCLAW_HOME: tempHome,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: undefined,
        TMPDIR: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        PATH: path.dirname(process.execPath),
        ...testCase.overrides,
      },
      { inheritEnvironment: false },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe("error" in testCase ? 1 : 0);
    if ("error" in testCase) {
      expect(result.stderr).toContain(testCase.error);
      expectCliError(result.stdout, testCase.error);
    } else {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
    await expectMissing(path.join(stateDir, "state", "openclaw.sqlite"));
    expect(await fs.readFile(configPath, "utf8")).toBe(config);
    expect(await fs.stat(configPath)).toMatchObject({ ino, mode, mtimeMs, ctimeMs });
  });
});

it.each(
  [
    {
      name: "malformed path",
      config: {},
      key: "gateway.__proto__.token",
      message: "Invalid path segment: __proto__",
    },
    {
      name: "invalid configuration",
      config: { gateway: { bind: "not-a-supported-mode" } },
      key: "gateway.port",
      message: "OpenClaw config is invalid",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "gateway.bind", message: expect.any(String) }),
      ]),
    },
  ].flatMap((testCase) => [
    { ...testCase, overrides: {}, name: `routed ${testCase.name}` },
    {
      ...testCase,
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
      name: `Commander ${testCase.name}`,
    },
  ]),
)("reports $name as JSON without creating state", async (testCase) => {
  await withCliHome(async (tempHome) => {
    const stateDir = path.join(tempHome, "read-only-state");
    const configPath = path.join(tempHome, "read-only-openclaw.json");
    await writeJson(configPath, testCase.config, true);

    const result = runBuiltCli(tempHome, ["config", "get", testCase.key, "--json"], {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      ...testCase.overrides,
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining(testCase.message),
      },
      ...("issues" in testCase ? { issues: testCase.issues } : {}),
    });
    expect(result.stderr).toBe("");
    await expectMissing(path.join(stateDir, "state", "openclaw.sqlite"));
  });
});

it.each([
  { name: "default service", inheritedProfile: undefined, inheritedStateName: ".openclaw" },
  { name: "named service", inheritedProfile: "main", inheritedStateName: ".openclaw-main" },
])("resolves the requested profile from inherited $name state", async (inherited) => {
  await withCliHome(async (tempHome) => {
    const inheritedStateDir = path.join(tempHome, inherited.inheritedStateName);
    const result = runBuiltCli(tempHome, ["--profile", "work", "config", "file"], {
      OPENCLAW_PROFILE: inherited.inheritedProfile,
      OPENCLAW_STATE_DIR: inheritedStateDir,
      OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(tempHome, ".openclaw-work", "openclaw.json"));
    await expectMissing(path.join(tempHome, ".openclaw-work"));
  });
});

it("keeps default-profile exec approvals untouched for a scratch-state config query", async () => {
  await withCliHome(async (tempHome) => {
    const defaultStateDir = path.join(tempHome, ".openclaw");
    const scratchStateDir = path.join(tempHome, "scratch-state");
    const approvalsPath = path.join(defaultStateDir, "exec-approvals.json");
    const approvals = '{"version":1,"approvals":{"demo":true}}\n';
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.mkdir(scratchStateDir, { recursive: true });
    await fs.writeFile(approvalsPath, approvals, "utf8");

    const result = runBuiltCli(tempHome, ["config", "file"], {
      OPENCLAW_STATE_DIR: scratchStateDir,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(scratchStateDir, "openclaw.json"));
    await expect(fs.readFile(approvalsPath, "utf8")).resolves.toBe(approvals);
    await expectMissing(
      `${approvalsPath}.migrated`,
      path.join(scratchStateDir, "exec-approvals.json"),
      path.join(scratchStateDir, "state", "openclaw.sqlite"),
    );
  });
});

it("keeps `config schema` stdout parseable at debug log level", async () => {
  await withCliHome(async (tempHome) => {
    const result = runBuiltCli(tempHome, ["config", "schema"], {
      OPENCLAW_LOG_LEVEL: "debug",
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      properties?: Record<string, unknown>;
    };
    expect(parsed.properties?.$schema).toEqual({ type: "string" });
    expect(result.stdout).not.toContain("possibly sensitive key found");
    expect(result.stderr).not.toContain("possibly sensitive key found");
  });
});

it("keeps `config validate --json` stdout parseable at debug log level", async () => {
  await withCliHome(async (tempHome) => {
    const configPath = path.join(tempHome, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const result = runBuiltCli(tempHome, ["config", "validate", "--json"], {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_LOG_LEVEL: "debug",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      path: configPath,
    });
    expect(result.stdout).not.toContain("possibly sensitive key found");
  });
});
