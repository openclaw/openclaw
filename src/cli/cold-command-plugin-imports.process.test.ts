import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";

const execFileAsync = promisify(execFile);
const directories = useAutoCleanupTempDirTracker(afterEach);

function writeFixture(dir: string, files: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
}

const commands = {
  hooks: ["hooks", "--json"],
  "skills-info": ["skills", "info", "fixture-skill", "--json"],
  "memory-status": ["memory", "status", "--agent", "main", "--json"],
};

it.each(Object.entries(commands))(
  "keeps an unrelated plugin runtime cold for %s",
  async (label, args) => {
    const needsMemoryOwner = label === "memory-status";
    const root = directories.make(`openclaw-cold-${label}-`);
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const pluginDir = path.join(root, "cold-plugin");
    const memoryOwnerDir = path.join(root, "memory-owner");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeFixture(path.join(workspaceDir, "skills", "fixture-skill"), {
      "SKILL.md": "---\nname: fixture-skill\ndescription: Cold path fixture\n---\n",
    });
    const fixture = createColdPluginFixture({
      rootDir: pluginDir,
      pluginId: `cold-${label}`,
      manifest: { providers: [], channels: [], providerAuthChoices: [], channelConfigs: {} },
    });
    if (needsMemoryOwner) {
      // The selected owner must execute while the unrelated sentinel stays cold.
      writeFixture(memoryOwnerDir, {
        "package.json": {
          name: "@example/openclaw-memory-owner",
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"] },
        },
        "openclaw.plugin.json": {
          id: "memory-owner",
          configSchema: { type: "object" },
          commandAliases: [{ name: "fixture-memory", kind: "runtime-slash", cliCommand: "memory" }],
        },
        "index.cjs": `const fs = require("node:fs");
module.exports = {
  id: "memory-owner",
  register(api) {
    fs.writeFileSync(process.env.MEMORY_OWNER_MARKER, "loaded", "utf8");
    api.registerCli(({ program }) => {
      const memory = program.command("memory");
      memory.command("status").option("--agent <id>").option("--json").action(() => console.log("[]"));
    }, { descriptors: [{ name: "memory", description: "Memory fixture", hasSubcommands: true }] });
  },
};
`,
      });
    }
    const configPath = path.join(stateDir, "openclaw.json");
    writeFixture(stateDir, {
      "openclaw.json": {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: {
          load: { paths: [pluginDir, ...(needsMemoryOwner ? [memoryOwnerDir] : [])] },
          entries: {
            [fixture.pluginId]: { enabled: true },
            ...(needsMemoryOwner ? { "memory-owner": { enabled: true } } : {}),
          },
        },
      },
    });

    await execFileAsync(
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
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    if (needsMemoryOwner) {
      expect(fs.existsSync(path.join(root, "memory-owner-loaded"))).toBe(true);
    }
  },
  150_000,
);

function writeCliDiscoveryFixture(root: string, kind: "modern" | "legacy") {
  const pluginId = `fixture-cli-${kind}`;
  const command = `fixture-${kind}-root`;
  const pluginDir = path.join(root, "plugin");
  const marker = path.join(root, "plugin.log");
  const stateDir = path.join(root, "state");
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  const tmp = path.join(root, "tmp");
  for (const directory of [pluginDir, stateDir, home, cwd, tmp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const descriptor = { name: command, description: "CLI discovery fixture", hasSubcommands: false };
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      ...(kind === "modern" ? { cliCommands: [descriptor] } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    [
      'import fs from "node:fs";',
      `const marker = ${JSON.stringify(marker)};`,
      'fs.appendFileSync(marker, "import " + import.meta.url + "\\n");',
      "export default function register(api) {",
      '  fs.appendFileSync(marker, "register " + api.registrationMode + "\\n");',
      "  api.registerCli(({ program }) => {",
      `    program.command(${JSON.stringify(command)}).action(() => {`,
      '      fs.appendFileSync(marker, "action\\n");',
      '      process.stdout.write("PROBE_ACTION_OK\\n");',
      "    });",
      `  }, ${JSON.stringify(kind === "modern" ? { descriptors: [descriptor] } : { commands: [command] })});`,
      "}",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  const config = {
    logging: { level: "silent", consoleLevel: "silent", file: path.join(root, "cli.log") },
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginDir] },
      slots: { memory: "none" },
      entries: { [pluginId]: { enabled: true } },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return {
    config,
    configPath,
    pluginId,
    pluginDir,
    command,
    cwd,
    marker,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DEV_SOURCE_ROOT: path.resolve("."),
      // This process fixture owns discovery, not the launcher's respawn behavior.
      OPENCLAW_NO_RESPAWN: "1",
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      XDG_STATE_HOME: stateDir,
      XDG_CACHE_HOME: tmp,
      XDG_RUNTIME_DIR: tmp,
      TMPDIR: tmp,
      NO_COLOR: "1",
    },
  };
}

it.each([
  { label: "unowned root", kind: "modern", owned: false, legacyPeer: false },
  { label: "unowned root with a legacy peer", kind: "modern", owned: false, legacyPeer: true },
  { label: "manifest-owned root", kind: "modern", owned: true, legacyPeer: false },
  { label: "legacy commands-only root", kind: "legacy", owned: true, legacyPeer: false },
] as const)(
  "resolves $label without broadening plugin discovery",
  async ({ kind, owned, legacyPeer }) => {
    const root = directories.make("openclaw-cli-discovery-");
    const fixture = writeCliDiscoveryFixture(root, kind);
    const legacy = legacyPeer
      ? writeCliDiscoveryFixture(path.join(root, "legacy-peer"), "legacy")
      : undefined;
    if (legacy) {
      fixture.config.plugins.allow.push(legacy.pluginId);
      fixture.config.plugins.load.paths.push(legacy.pluginDir);
      fixture.config.plugins.entries[legacy.pluginId] = { enabled: true };
      fs.writeFileSync(fixture.configPath, JSON.stringify(fixture.config));
    }
    const command = owned ? fixture.command : "fixture-unregistered-command";
    const result = await new Promise<{
      exitCode: ExecFileException["code"];
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)), command],
        {
          cwd: fixture.cwd,
          env: fixture.env,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 60_000,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? error.code : 0,
            signal: error?.signal ?? null,
            stdout,
            stderr,
          });
        },
      );
    });
    const observations = fs.existsSync(fixture.marker)
      ? fs.readFileSync(fixture.marker, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(result).toMatchObject({ exitCode: owned ? 0 : 1, signal: null });
    if (owned) {
      expect(result.stdout).toContain("PROBE_ACTION_OK");
      expect(observations).toContain("action");
    } else {
      expect(`${result.stdout}\n${result.stderr}`).toContain(command);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /does not know the command|unknown command/u,
      );
      expect(observations).toEqual([]);
      if (legacy) {
        expect(fs.readFileSync(legacy.marker, "utf8")).toContain("register cli-metadata");
      }
    }
  },
  150_000,
);
