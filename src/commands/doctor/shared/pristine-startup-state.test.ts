import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canSkipPristineStartupStateMigrations } from "./pristine-startup-state.js";

const roots: string[] = [];

function createFixture(config: Record<string, unknown>, stateEntries: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pristine-startup-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  fs.mkdirSync(stateDir, { recursive: true });
  for (const entry of stateEntries) {
    fs.mkdirSync(path.join(stateDir, entry), { recursive: true });
  }
  return {
    HOME: root,
    OPENCLAW_CONFIG: configPath,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function addBundledPlugin(
  env: ReturnType<typeof createFixture>,
  pluginId: string,
  options: { doctorContract?: boolean } = {},
) {
  const bundledPluginsDir = path.join(env.HOME, "bundled-plugins");
  const pluginDir = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId })}\n`,
  );
  if (options.doctorContract) {
    fs.writeFileSync(path.join(pluginDir, "doctor-contract-api.js"), "export {};\n");
  }
  return {
    ...env,
    VITEST: "true",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("pristine startup state", () => {
  it("accepts the core-only Gateway benchmark config", () => {
    const env = createFixture({
      browser: { enabled: false },
      gateway: { mode: "local" },
      plugins: { enabled: true, entries: { browser: { enabled: false } } },
    });

    expect(canSkipPristineStartupStateMigrations(env)).toBe(true);
  });

  it("rejects existing state and migration-bearing agent config", () => {
    expect(canSkipPristineStartupStateMigrations(createFixture({}, ["agents"]))).toBe(false);
    expect(
      canSkipPristineStartupStateMigrations(
        createFixture({ agents: { defaults: { memorySearch: { provider: "local" } } } }),
      ),
    ).toBe(false);
  });

  it("accepts normal agent/model config backed by a stateless bundled plugin", () => {
    const env = addBundledPlugin(
      createFixture({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6" },
            models: { "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } } },
            workspace: "/tmp/workspace",
          },
          list: [{ id: "main", workspace: "/tmp/workspace" }],
        },
        plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
        skills: { allowBundled: [] },
      }),
      "openai",
    );

    expect(canSkipPristineStartupStateMigrations(env)).toBe(true);
  });

  it("retains migrations for bundled plugins with doctor state surfaces", () => {
    const env = addBundledPlugin(
      createFixture({ plugins: { entries: { example: { enabled: true } } } }),
      "example",
      { doctorContract: true },
    );

    expect(canSkipPristineStartupStateMigrations(env)).toBe(false);
  });

  it("rejects enabled plugin entries and includes", () => {
    expect(
      canSkipPristineStartupStateMigrations(
        createFixture({ plugins: { entries: { example: { enabled: true } } } }),
      ),
    ).toBe(false);
    expect(canSkipPristineStartupStateMigrations(createFixture({ $include: "base.json" }))).toBe(
      false,
    );
  });
});
