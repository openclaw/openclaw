import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";

const execFileAsync = promisify(execFile);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cold-commands-"));

function writeFixture(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const commands = {
  hooks: ["hooks", "--json"],
  "skills-info": ["skills", "info", "fixture-skill", "--json"],
  "memory-status": ["memory", "status", "--agent", "main", "--json"],
};

it.each(Object.entries(commands))(
  "keeps an unrelated plugin runtime cold for %s",
  async (label, args) => {
    const needsMemoryOwner = label === "memory-status";
    const root = path.join(tempRoot, label);
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "cold-plugin");
    const memoryOwnerDir = path.join(root, "memory-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeFixture(
      path.join(workspaceDir, "skills", "fixture-skill"),
      "SKILL.md",
      "---\nname: fixture-skill\ndescription: Cold path fixture\n---\n",
    );
    const fixture = createColdPluginFixture({
      rootDir: pluginDir,
      pluginId: `cold-${label}`,
      runtimeMessage: `${label} imported an unrelated plugin runtime`,
      manifest: { providers: [], channels: [], providerAuthChoices: [], channelConfigs: {} },
    });
    if (needsMemoryOwner) {
      // The selected owner must execute while the unrelated sentinel stays cold.
      writeFixture(memoryOwnerDir, "package.json", {
        name: "@example/openclaw-memory-owner",
        version: "1.0.0",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      });
      writeFixture(memoryOwnerDir, "openclaw.plugin.json", {
        id: "memory-owner",
        name: "Memory Owner",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        commandAliases: [{ name: "fixture-memory", kind: "runtime-slash", cliCommand: "memory" }],
      });
      writeFixture(
        memoryOwnerDir,
        "index.cjs",
        [
          'const fs = require("node:fs");',
          "module.exports = {",
          '  id: "memory-owner",',
          "  register(api) {",
          '    fs.writeFileSync(process.env.MEMORY_OWNER_MARKER, "loaded", "utf8");',
          "    api.registerCli(({ program }) => {",
          '      const memory = program.command("memory");',
          '      memory.command("status").option("--agent <id>").option("--json").action(() => console.log("[]"));',
          '    }, { descriptors: [{ name: "memory", description: "Memory fixture", hasSubcommands: true }] });',
          "  },",
          "};",
          "",
        ].join("\n"),
      );
    }
    const configPath = path.join(stateDir, "openclaw.json");
    writeFixture(stateDir, "openclaw.json", {
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        load: { paths: [pluginDir, ...(needsMemoryOwner ? [memoryOwnerDir] : [])] },
        entries: {
          [fixture.pluginId]: { enabled: true },
          ...(needsMemoryOwner ? { "memory-owner": { enabled: true } } : {}),
        },
      },
    });

    const result = await execFileAsync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)), ...args],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          // This fixture owns command imports, not entrypoint respawn or compile-cache behavior.
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          VITEST: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          MEMORY_OWNER_MARKER: path.join(root, "memory-owner-loaded"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_DEV_SOURCE_ROOT: path.resolve("."),
          OPENCLAW_HOME: path.join(root, "home"),
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      `${label} imported an unrelated plugin runtime`,
    );
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    if (needsMemoryOwner) {
      expect(fs.existsSync(path.join(root, "memory-owner-loaded"))).toBe(true);
    }
  },
  150_000,
);
