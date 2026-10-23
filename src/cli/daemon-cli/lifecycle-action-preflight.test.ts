import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { resetDatabaseEngineSelectionForTest } from "../../infra/database-engine/context.test-support.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { getServiceActionPreflightFailure as preflight } from "./lifecycle-action-preflight.js";

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

async function withState(
  run: (params: { agentDir: string; configPath: string }) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix: "openclaw-lifecycle-action-preflight-" }, async (root) => {
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n");
    vi.stubEnv("HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    resetConfigRuntimeState();
    await run({ agentDir, configPath });
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
}

async function writeJson(file: string, value: unknown) {
  await fs.writeFile(file, JSON.stringify(value));
}

it("reports an unresolved candidate database without opening fallback state before restart", async () => {
  await withState(async ({ configPath }) => {
    await writeJson(configPath, {
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "MISSING_RESTART_DSN" },
        },
      },
      plugins: { enabled: false },
    });
    delete process.env.MISSING_RESTART_DSN;
    resetDatabaseEngineSelectionForTest();
    expect(await preflight("restart")).toMatchObject({
      message: expect.stringContaining("SecretRef is unresolved"),
    });
  });
});

it.each(["start", "stop"] as const)("allows %s with legacy credentials", async (action) => {
  await withState(async ({ agentDir }) => {
    await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");

    await expect(preflight(action)).resolves.toBeNull();
  });
});

it("validates plugins only for actions that start the service", async () => {
  await withState(async ({ configPath }) => {
    const pluginRoot = path.join(path.dirname(configPath), "migration-fixture");
    await fs.mkdir(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, "index.js"), "export default {};\n");
    await writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "migration-fixture",
      configSchema: {
        type: "object",
        required: ["current"],
        properties: { current: { type: "boolean" } },
        additionalProperties: false,
      },
    });
    const config = {
      plugins: {
        allow: ["migration-fixture"],
        load: { paths: [pluginRoot] },
        entries: { "migration-fixture": { enabled: true, config: { legacy: true } } },
      },
    };
    await writeJson(configPath, config);
    resetConfigRuntimeState();
    expect(await preflight("start")).toMatchObject({
      message: expect.stringContaining("plugins.entries.migration-fixture"),
    });
    expect(await preflight("restart")).not.toBeNull();
    expect(await preflight("stop")).toBeNull();
    expect(await preflight("uninstall")).toBeNull();

    await writeJson(configPath, { ...config, meta: { lastTouchedVersion: "9999.1.1" } });
    resetConfigRuntimeState();
    expect((await preflight("stop"))?.message).toContain(
      "Config was last written by OpenClaw 9999.1.1",
    );
  });
});

it.each(["start", "stop", "uninstall"] as const)(
  "reports invalid config before %s",
  async (action) => {
    await withState(async ({ configPath }) => {
      await fs.writeFile(
        configPath,
        '{\n  meta: { lastTouchedVersion: "9999.1.1" },\n  gateway: { mode: "nope" },\n}\n',
      );
      resetConfigRuntimeState();

      const failure = await preflight(action);

      expect(failure?.message).toContain(
        'openclaw.json:3 — gateway.mode: Invalid input (allowed: "local", "remote"), got: "nope"',
      );
      expect(failure?.message).toContain(
        "Config was last written by OpenClaw 9999.1.1, but you are running",
      );
    });
  },
);
